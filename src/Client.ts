import * as Discord from "discord.js"
import model_user from './mongoose/model/user'
import { TCPApi, base58, HTTPApi, beautifyBigInt, parseBigInt, Address, PaymentProcessor, Transaction, isValidAddress } from 'viscoin'
import * as viscoin from 'viscoin'
import * as config from '../config.json'
import * as crypto from 'crypto'
import * as mongoose from "mongoose"
import * as qrcode from 'qrcode'
import Coinbase from './Coinbase'

interface Client extends Discord.Client {
    owners: Array<String>
    tcpClient
    charges: Map<string, {
        amount: bigint
        channelId: string
        transactions: Array<{
            hash: Buffer
            height: number
            amount: bigint
        }>
    }>
    paymentProcessor
    priceModifier: number
    HTTP_API: {
        host: string
        port: number
    }
    TCP_API: {
        host: string
        port: number
    },
    liveFeed: {
        block: Set<string>
        transaction: Set<string>
    }
}
class Client extends Discord.Client {
    constructor() {
        super({
            intents: [
                Discord.Intents.FLAGS.GUILDS,
                Discord.Intents.FLAGS.GUILD_MESSAGES
            ]
        })
        this.owners = process.env.owners?.split(',')
        console.log("owner id's", this.owners)
        const HTTP_API = process.env.HTTP_API || viscoin.config.default_env.HTTP_API
        this.HTTP_API = {
            host: HTTP_API.split(':').slice(0, -1).join(':'),
            port: parseInt(HTTP_API.split(':').reverse()[0])
        }
        const TCP_API = process.env.TCP_API || viscoin.config.default_env.TCP_API
        this.TCP_API = {
            host: TCP_API.split(':').slice(0, -1).join(':'),
            port: parseInt(TCP_API.split(':').reverse()[0])
        }
        this.charges = new Map()
        this.liveFeed = {
            block: new Set(),
            transaction: new Set()
        }
        console.log(`Loaded wallet ${Address.toString(Address.fromPrivateKey(base58.decode(process.env.privateKey)))}`)
        this.tcpClient = TCPApi.createClient()
        this.once('ready', () => {
            this.tcpClient.connect(this.TCP_API.port, this.TCP_API.host, true)
            this.paymentProcessor = new PaymentProcessor(base58.decode(process.env.privateKey), config.confirmations, this.HTTP_API, this.tcpClient, mongoose, { id: String, userId: String, channelId: String, messageId: String, type: String }, true)
            this.paymentProcessor.on('charge-pending', async (charge, block) => {
                console.log(`Charge pending: ${charge.id}`)
                if (!block) {
                    const channel = <Discord.TextChannel> this.channels.cache.get(charge.channelId)
                    const message = await channel.send(Client.message.verifying_payment(charge.userId, 0))
                    charge.status = 'PENDING'
                    charge.messageId = message.id
                    await charge.save()
                }
                if (charge.payments.length) {
                    const payment = charge.payments[charge.payments.length - 1]
                    const confirmations = block.height - payment.block.height + 1
                    if (confirmations <= config.confirmations) {
                        const channel = <Discord.TextChannel> this.channels.cache.get(charge.channelId)
                        const message = await channel.messages.fetch(charge.messageId)
                        if (message) message.edit(Client.message.verifying_payment(charge.userId, confirmations))
                    }
                }
            })
            this.paymentProcessor.on('charge-completed', async charge => {
                console.log(`Charge completed: ${charge.id}`)
                const channel = <Discord.TextChannel> this.channels.cache.get(charge.channelId)
                switch (charge?.type) {
                    case 'deposit':
                        const user = await this.getUserById(charge.userId)
                        user.credits = beautifyBigInt(parseBigInt(user.credits) + parseBigInt(charge.amount))
                        user.save()
                        break
                }
                let received = 0n
                for (const payment of charge.payments) {
                    received += parseBigInt(payment.amount)
                }
                const data = {
                    id: charge.id,
                    status: charge.status,
                    amount: charge.amount,
                    address: charge.address,
                    payments: charge.payments.length,
                    received: beautifyBigInt(received),
                    created: new Date(charge.created).toUTCString(),
                    expires: new Date(charge.expires).toUTCString()
                }
                this.users.cache.get(charge.userId).send(`\`\`\`json\n${JSON.stringify(data, null, 4)}\`\`\``)
                channel.send(`**Thank you** <@!${charge.userId}>\nYour payment is complete.\nA receipt has been sent to you in your dm's.`)
            })
            this.paymentProcessor.on('charge-canceled', charge => {
                console.log(`Charge canceled: ${charge.id}`)
            })
            this.paymentProcessor.on('charge-new', charge => {
                console.log(`Charge new: ${charge.id}, ${charge.amount}`)
            })
            this.paymentProcessor.on('withdraw-all-balance', (code, transaction) => {
                console.log(`Withdrawing all balance from ${base58.encode(transaction.from)}, code: ${code}`)
            })
            this.tcpClient.on('block', async block => {
                for (const channelId of this.liveFeed.block) {
                    const channel = <Discord.TextChannel> this.channels.cache.get(channelId)
                    channel.send(await Client.message.block(block))
                }
            })
            this.tcpClient.on('transaction', async transaction => {
                for (const channelId of this.liveFeed.transaction) {
                    const channel = <Discord.TextChannel> this.channels.cache.get(channelId)
                    channel.send(await Client.message.transaction(transaction))
                }
            })
        })
        this.on('ready', () => console.log(`Logged in as ${this.user.tag}!`))
        this.on('message', async e => {
            if (e.author.bot) return
            try {
                const transaction = new Transaction(JSON.parse(e.content))
                if (transaction.isValid() === 0) {
                    const code = await HTTPApi.send(this.HTTP_API, transaction)
                    e.react(code === 0 ? '🟢' : '🔴').then(r => {
                        setTimeout(() => {
                            e.delete()
                        }, 3000)
                    })
                }
            }
            catch {}
            if (!e.content.startsWith(config.prefix)) return
            const args = e.content.slice(config.prefix.length).trim().split(' ').filter(e => e !== '')
            const command = args.shift()?.toLowerCase()
            if (this.commands[command]) this.commands[command](e, args)
        })
        setTimeout(async function checkCoinbaseCharges() {
            const users = await model_user.find({ coinbase_charge_code: { $exists: true } })
            for (const user of users) {
                const charge = await Coinbase.retrieveCharge(user.coinbase_charge_code)
                if (!charge) continue
                const event = charge.timeline[charge.timeline.length - 1]
                console.log(charge.code, event.status)
                if (event.status === 'COMPLETED') {
                    console.log('COMPLETED')
                    user.credits = beautifyBigInt(parseBigInt(user.credits) + parseBigInt(charge.metadata.amount))
                }
                if ([ 'COMPLETED', 'RESOLVED', 'EXPIRED', 'CANCELED', 'REFUNDED' ].includes(event.status)) {
                    user.coinbase_charge_code = undefined
                    await user.save()
                }
            }
            setTimeout(checkCoinbaseCharges, 60000)
        }, 3000)
    }
    async getUserById(id: string) {model_user
        let user = await model_user.findOne({ id })
        if (!user) user = await new model_user({
            id,
            credits: '0'
        }).save()
        return user
    }
    commands = {
        live: async (message, args) => {
            if (!(message.member.permissions.bitfield & 0x8n)) return message.react('🚫')
            const type = args.shift()
            if (type === 'block') {
                if (this.liveFeed.block.has(message.channel.id)) {
                    this.liveFeed.block.delete(message.channel.id)
                    message.reply('Block live feed turned: off')
                }
                else {
                    this.liveFeed.block.add(message.channel.id)
                    message.reply('Block live feed turned: on')
                }
            }
            else if (type === 'transaction') {
                if (this.liveFeed.transaction.has(message.channel.id)) {
                    this.liveFeed.transaction.delete(message.channel.id)
                    message.reply('Transaction live feed turned: off')
                }
                else {
                    this.liveFeed.transaction.add(message.channel.id)
                    message.reply('Transaction live feed turned: on')
                }
            }
            else message.react('🚫')
        },
        request: async (message, args) => {
            let str = 'https://viscoin.net/#/wallet?'
            const address = args.shift()
            try {
                if (Buffer.byteLength(Address.toBuffer(address)) !== 20) return
                if (address) str += 'to=' + address
                const amount = args.shift()
                if (amount) str += '&amount=' + amount
                const buffer = await qrcode.toBuffer(str, {
                    errorCorrectionLevel: 'L'
                })
                message.channel.send({content: `Send${amount ? ' ' + amount : ''} VIS to *${address}*`, files: [{name: "qr.png", attachment: buffer}]})
            }
            catch {}
        },
        checksum: (message, args) => {
            try {
                const buffer = base58.decode(args.shift())
                message.react(Address.verifyChecksumAddress(buffer) ? '✅' : '🚫')
            }
            catch {
                message.react('🚫')
            }
        },
        block: async (message, args) => {
            const arg = args.shift()
            if (!arg) {
                const block = await HTTPApi.getLatestBlock(this.HTTP_API)
                return message.reply(await Client.message.block(block))
            }
            try {
                const hash = Buffer.from(arg, 'hex')
                if (Buffer.byteLength(hash) === 32) {
                    const block = await HTTPApi.getBlockByHash(this.HTTP_API, hash)
                    return message.reply(await Client.message.block(block))
                }
            }
            catch {}
            const height = parseInt(arg)
            if (height.toString() !== arg) return message.react('🚫')
            const block = await HTTPApi.getBlockByHeight(this.HTTP_API, height)
            message.reply(await Client.message.block(block))
        },
        balance: async (message, args) => {
            const address = args.shift()
            try {
                if (!Address.verifyChecksumAddress(base58.decode(address))) return message.react('🚫')
                const balance = await HTTPApi.getBalanceOfAddress(this.HTTP_API, address)
                message.reply(await Client.message.balance(address, balance))
            }
            catch {
                message.react('🚫')
            }
        },
        address: (message, args) => {
            const arg = args.shift()
            try {
                const buffer = base58.decode(arg)
                if (Address.verifyChecksumAddress(buffer)) {
                    const v1 = base58.encode(Address.convertToNormalAddress(buffer))
                    return message.reply(Client.message.address(v1, arg))
                }
                if (isValidAddress(arg)) {
                    const v2 = base58.encode(Address.convertToChecksumAddress(buffer))
                    return message.reply(Client.message.address(arg, v2))
                }
                message.react('🚫')
            }
            catch {
                message.react('🚫')
            }
        },
        credits: async (message) => {
            try {
                const mentioned_user = message.mentions.users.first()
                if (mentioned_user) {
                    const user = await this.getUserById(mentioned_user.id)
                    return message.reply(Client.message.credits(user.id, user.credits))
                }
                const user = await this.getUserById(message.author.id)
                message.reply(Client.message.credits(user.id, user.credits))
            }
            catch (e) { console.log(e)}
        },
        withdraw: async (message, args) => {
            try {
                const user = await model_user.findOne({ id: message.author.id })
                if (!user) return
                const amount = parseBigInt(args.shift())
                if (!amount || amount <= 0n) return
                if (amount > parseBigInt(user.credits)) return message.reply('You are too poor!')
                const address = args.shift()
                try {
                    if (!Address.verifyChecksumAddress(base58.decode(address))) return message.reply('Invalid address!')
                }
                catch {
                    return message.reply('Invalid address!')
                }
                user.credits = beautifyBigInt(parseBigInt(user.credits) - amount)
                await user.save()
                const { code, transaction } = await this.paymentProcessor.send(base58.encode(Address.toBuffer(address)), beautifyBigInt(amount))
                console.log(`Withdrawal ${beautifyBigInt(amount)} --> ${address}, code: ${code}, fee: ${transaction.minerFee}`)
                message.channel.send(`**Withdrawal** <@!${user.id}>\nWithdrawing \`${beautifyBigInt(amount)}\` VIS to \`${address}\`.\nPlease wait for the network to verify the transaction.`)
            }
            catch (err) {
                console.log(err)
            }
        },
        deposit: async (message, args) => {
            const arg = args.shift()
            if (!arg) {
                const charge = await this.paymentProcessor.getCharge({ userId: message.author.id, })
                if (!charge) return message.reply(`You don't have an active charge!`)
                return message.reply(await Client.message.deposit(charge))
            }
            const amount = parseBigInt(arg)
            if (!amount || amount <= 0n) return message.reply(`Invalid amount!`)
            if (await this.paymentProcessor.getCharge({ userId: message.author.id })) return message.reply(`You already have an active charge!\nDo \`!cancel\` to cancel it.`)
            const charge = await this.paymentProcessor.createCharge(beautifyBigInt(amount), config.chargeExpiresAfter, {
                id: base58.encode(crypto.randomBytes(8)),
                channelId: message.channel.id,
                userId: message.author.id,
                type: 'deposit'
            })
            message.reply(await Client.message.deposit(charge))
        },
        cancel: async message => {
            try {
                const canceled = await this.paymentProcessor.cancelCharge({ userId: message.author.id })
                if (canceled === true) return message.reply('Charge canceled.')
                message.reply(`You don't have an active charge!`)
            }
            catch (err) {
                console.log(err)
            }
        },
        bet: async (message, args) => {
            try {
                const roll = Math.floor(Math.random() * 15)
                let color = ''
                if (roll === 14) color = 'green'
                else if (roll % 2 === 0) color = 'red'
                else color = 'black'
                const str = `${base58.encode(crypto.randomBytes(16))} ${color} ${base58.encode(crypto.randomBytes(16))}`
                const hash = crypto.createHash('sha256').update(str).digest('hex')
                message.channel.send(`**Create bet** <@!${message.author.id}>\nHow much do you wan't to bet?\n\`${hash}\``)
                const prompt_amount = await message.channel.awaitMessages(res => res.author.id === message.author.id, {
                    max: 1,
                    time: 30000
                })
                if(!prompt_amount.first()) return message.reply('You took too long to respond! try again')
                const amount = parseBigInt(prompt_amount.first().content.trim())
                if (!amount) return message.reply('Invalid amount!')
                if (amount > parseBigInt(config.maxBet)) return message.reply(`Sorry, your bet is bigger than the maximum allowed bet \`${config.maxBet}\`.`)

                const user = await model_user.findOne({ id: message.author.id })
                if (!user) return
                if (amount > parseBigInt(user.credits)) return message.reply('You are too poor!')

                message.channel.send(`**Create bet** <@!${message.author.id}>\nWhat color do you want to bet on?\n\`red\` \`black\` **2x** | **14x** \`green\``)
                const prompt_color = await message.channel.awaitMessages(res => res.author.id === message.author.id, {
                    max: 1,
                    time: 30000
                })
                if(!prompt_color.first()) return message.reply('You took too long to respond! try again')

                const _color = prompt_color.first().content.trim().toLowerCase()
                let multiplier = 1n
                switch (_color) {
                    case 'red':
                        multiplier = 2n
                        break
                    case 'black':
                        multiplier = 2n
                        break
                    case 'green':
                        multiplier = 14n
                        break
                    default:
                        return message.reply('Specify a color to bet on!')
                }

                const credits = parseBigInt(user.credits)
                if (credits < amount) return message.reply('You are too poor!')
                let emoji = ''
                if (color === 'green') emoji = ':green_circle:'
                else if (color === 'red') emoji = ':red_circle:'
                else if (color === 'black') emoji = ':black_circle:'
                if (color === _color) {
                    user.credits = beautifyBigInt(credits - amount + amount * multiplier)
                    await user.save()
                    message.channel.send(`**You won!** <@!${message.author.id}>\n${emoji} \`+${beautifyBigInt(amount * multiplier)}\`\n*You can verify that the string below matches the sha256 hash.*\n\`${str}\``)
                }
                else {
                    user.credits = beautifyBigInt(credits - amount)
                    await user.save()
                    message.channel.send(`**You lost!** <@!${message.author.id}>\n${emoji} \`-${beautifyBigInt(amount)}\`\n*You can verify that the string below matches the sha256 hash.*\n\`${str}\``)
                }
            }
            catch (err) {
                console.log(err)
            }
        },
        pay: async (message, args) => {
            try {
                const mentioned_user = message.mentions.users.first()
                if (!mentioned_user) return message.reply('No recipient specified.')
                if (mentioned_user.bot) return message.reply(`You can't send credits to a bot!`)
                args = args.filter(e => !e.startsWith('<@!'))
                const amount = parseBigInt(args.shift())
                if (!amount || amount <= 0n) return message.reply('Invalid amount!')
                console.log('payment', amount, mentioned_user.id)
                const sender = await this.getUserById(message.author.id)
                if (parseBigInt(sender.credits) - amount < 0n) return message.reply('You are too poor!')
                sender.credits = beautifyBigInt(parseBigInt(sender.credits) - amount)
                await sender.save()
                const receiver = await this.getUserById(mentioned_user.id)
                receiver.credits = beautifyBigInt(parseBigInt(receiver.credits) + amount)
                await receiver.save()
                message.reply(Client.message.pay(amount, sender, receiver))
            }
            catch {}
        },
        buy: async (message, args) => {
            if (!this.priceModifier) return message.channel.send('Price not set! Contact owner.')
            const user = await this.getUserById(message.author.id)
            const arg = args.shift()
            if (arg) {
                if (user.coinbase_charge_code) {
                    const charge = await Coinbase.retrieveCharge(user.coinbase_charge_code)
                    if (arg.toLowerCase() === 'cancel') {
                        await Coinbase.cancelCharge(charge.code)
                        user.coinbase_charge_code = undefined
                        await user.save()
                        message.reply('Canceled charge.')
                    }
                    else if (charge && ![ 'COMPLETED', 'RESOLVED', 'EXPIRED', 'CANCELED', 'REFUNDED' ].includes(charge.timeline[charge.timeline.length - 1].status)) message.reply(`You already have an active charge!\nDo \`${config.prefix}buy cancel\` to cancel it.`)
                    return
                }
                const amount = parseBigInt(arg)
                if (!amount || amount <= 0n) return message.reply('Invalid amount!')
                if (parseFloat(this.getPrice(amount).toFixed(2)) === 0) return message.reply('Amount is too small')
                const charge = await Coinbase.createCharge({
                    description: `This will add ${beautifyBigInt(amount)} credits to ${message.author.tag}'s balance.`,
                    metadata: {
                        userId: message.author.id,
                        amount: beautifyBigInt(amount)
                    },
                    name: `${beautifyBigInt(amount)} credits`,
                    pricing_type: 'fixed_price',
                    local_price: {
                        amount: this.getPrice(amount).toFixed(2),
                        currency: 'USD'
                    }
                })
                if (!charge) return message.reply('Failed to create charge!')
                user.coinbase_charge_code = charge.code
                await user.save()
                message.channel.send(await Client.message.coinbase_charge(charge))
                return
            }
            const charge = await Coinbase.retrieveCharge(user.coinbase_charge_code)
            if (charge) return message.channel.send(await Client.message.coinbase_charge(charge))
            message.reply(`You don't have an active charge.`)
        },
        price: async (message, args) => {
            message.channel.send(`\`1 credit = $${this.getPrice(parseBigInt('1'))}\``)
        },
        setprice: async (message, args) => {
            if (!this.owners.includes(message.author.id)) return message.react('🚫')
            const price = parseFloat(args.shift())
            if (isNaN(price)) return message.react('🚫')
            this.priceModifier = price
            message.react('✅')
            console.log('price', price)
            this.commands.price(message, args)
        },
        bank: async (message, args) => {
            const address = Address.toString(this.paymentProcessor.address())
            const balance = await HTTPApi.getBalanceOfAddress(this.HTTP_API, address)
            message.reply(await Client.message.balance(address, balance))
        }
    }
    static message = {
        deposit: async (charge) => {
            const str = `https://viscoin.net/#/wallet?to=${charge.address}&amount=${charge.amount}`
            const buffer = await qrcode.toBuffer(str, {
                errorCorrectionLevel: 'L'
            })
            const embed = new Discord.MessageEmbed({
                color: '#1652f0',
                description: `This will add **${charge.amount}** credits to <@${charge.userId}>'s balance.\nTo make a payment, send **\`${charge.amount}\`** VIS to the address below.\n**\`${charge.address}\`**`,
                timestamp: charge.expires,
                footer: {
                    text: 'Expires'
                },
                thumbnail: {
                    url: 'attachment://qr.png'
                }
            })
            return {
                files: [
                    {
                        name: 'qr.png',
                        attachment: buffer
                    }
                ],
                embeds: [
                    embed
                ]
            }
        },
        pay: (amount, sender, receiver) => {
            const embed = new Discord.MessageEmbed({
                title: 'Payment',
                description: `**\`-${beautifyBigInt(amount)}\`** <@${sender.id}>\n**\`+${beautifyBigInt(amount)}\`** <@${receiver.id}>`,
                thumbnail: {
                    url: 'https://cdn.discordapp.com/attachments/858330799627960351/858331288108924938/viscoin.png'
                },
                color: '#3d83c5'
            })
            return {
                embeds: [
                    embed
                ]
            }
        },
        credits: (id, credits) => {
            const embed = new Discord.MessageEmbed({
                title: 'Credits',
                description: `**\`${credits}\`** <@${id}>`,
                thumbnail: {
                    url: 'https://cdn.discordapp.com/attachments/858330799627960351/858331288108924938/viscoin.png'
                },
                color: '#3d83c5'
            })
            return {
                embeds: [
                    embed
                ]
            }
        },
        balance: async (address, balance) => {
            const str = `https://viscoin.net/#/explorer?search=balance/${address}`
            const buffer = await qrcode.toBuffer(str, {
                errorCorrectionLevel: 'L'
            })
            if (balance.includes('.')) balance = `**${balance.split('.')[0]}**.${balance.split('.')[1]}`
            else balance = `**${balance}**`
            const embed = new Discord.MessageEmbed({
                thumbnail: {
                    url: 'attachment://qr.png'
                },
                color: balance === '0' ? '#a30000' : '#00a300',
                fields: [
                    {
                        name: 'address',
                        value: address,
                        inline: true
                    },
                    {
                        name: 'balance',
                        value: balance,
                        inline: true
                    }
                ]
            })
            embed.setTitle('Click to open in Explorer')
            embed.setURL(str)
            return {
                files: [
                    {
                        name: 'qr.png',
                        attachment: buffer
                    }
                ],
                embeds: [
                    embed
                ]
            }
        },
        address: (v1, v2) => {
            const embed = new Discord.MessageEmbed()
            embed.addField('v1 address', v1, true)
            embed.addField('v2 address', v2, true)
            return {
                embeds: [
                    embed
                ]
            }
        },
        transaction: async (transaction) => {
            const embed = new Discord.MessageEmbed()
            if (transaction === null) {
                embed.setDescription('Transaction does not exist')
                return {
                    embeds: [
                        embed
                    ]
                }
            }
            const str = `https://viscoin.net/#/explorer?search=block/transaction/${base58.encode(transaction.signature)}`
            const buffer = await qrcode.toBuffer(str, {
                errorCorrectionLevel: 'L'
            })
            embed.setTimestamp(transaction.timestamp)
            if (transaction.from) embed.addField('from', Address.toString(transaction.from), true)
            if (transaction.to) embed.addField('to', Address.toString(transaction.to), true)
            if (transaction.amount) embed.addField('amount', transaction.amount, true)
            embed.addField('fee', transaction.minerFee, true)
            embed.setThumbnail('attachment://qr.png')
            embed.setURL(str)
            embed.setTitle('Click to open in Explorer')
            return {
                files: [
                    {
                        name: 'qr.png',
                        attachment: buffer
                    }
                ],
                embeds: [
                    embed
                ]
            }
        },
        block: async (block) => {
            const embed = new Discord.MessageEmbed()
            if (block === null) {
                embed.setDescription('Block does not exist')
                return {
                    embeds: [
                        embed
                    ]
                }
            }
            const str = `https://viscoin.net/#/explorer?search=block/${block.hash.toString('hex')}`
            const buffer = await qrcode.toBuffer(str, {
                errorCorrectionLevel: 'L'
            })
            embed.setColor(block.hash.toString('hex').slice(-6))
            embed.setTimestamp(block.timestamp)
            embed.addField('height', block.height.toString(), true)
            embed.addField('transactions', block.transactions.length.toString(), true)
            embed.addField('difficulty', block.difficulty.toString(), true)
            embed.addField('hash', block.hash.toString('hex'))
            embed.setThumbnail('attachment://qr.png')
            embed.setURL(str)
            embed.setTitle('Click to open in Explorer')
            if (block.transactions[0]) embed.addField('miner', Address.toString(block.transactions[0].to))
            return {
                files: [
                    {
                        name: 'qr.png',
                        attachment: buffer
                    }
                ],
                embeds: [
                    embed
                ]
            }
        },
        verifying_payment: (userId, confirmations) => {
            const embed = new Discord.MessageEmbed({
                title: '**Verifying payment**',
                description: `<@!${userId}> sent a payment! We are waiting for the network to verify it.\n\`${confirmations}/${config.confirmations}\` confirmations.`
            })
            return {
                embeds: [
                    embed
                ]
            }
        },
        coinbase_charge: async (charge) => {
            // const buffer = await qrcode.toBuffer(charge.hosted_url, {
            //     errorCorrectionLevel: 'L'
            // })
            const embed = new Discord.MessageEmbed({
                title: 'Click to open Payment',
                color: '#1652f0',
                description: `This will add **${charge.metadata.amount}** credits to <@${charge.metadata.userId}>'s balance.\n\n*The payment is processed by commerce.coinbase.com. This is not an exchange but only a way to purchase Viscoin with other crypto. The prices are set by the bot owner.*`,
                thumbnail: {
                    url: 'https://cdn.discordapp.com/attachments/858330799627960351/885917121299767306/c.png'
                    // url: 'attachment://qr.png'
                },
                timestamp: new Date(charge.expires_at).getTime(),
                footer: {
                    text: 'Expires'
                }
            })
            embed.setURL(charge.hosted_url)
            return {
                // files: [
                //     {
                //         name: 'qr.png',
                //         attachment: buffer
                //     }
                // ],
                embeds: [
                    embed
                ]
            }
        }
    }
    getPrice(amount: bigint) {
        return parseFloat(beautifyBigInt(amount)) * this.priceModifier
    }
}
export default Client