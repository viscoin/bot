import * as Discord from "discord.js"
import { TCPApi, base58, HTTPApi, beautifyBigInt, parseBigInt, Address, PaymentProcessor, Transaction, isValidAddress } from 'viscoin'
import * as viscoin from 'viscoin'
import * as config from '../config.json'
import * as crypto from 'crypto'
import * as qrcode from 'qrcode'
import Coinbase from './Coinbase'

interface Client extends Discord.Client {
    db: {
        users: any
        charges: any
        market: any
    }
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
        blocks: Map<string, string>
        transactions: Map<string, string>
        height
    }
}
class Client extends Discord.Client {
    constructor(chargesDB, usersDB, marketDB) {
        super({
            intents: [
                Discord.Intents.FLAGS.GUILDS,
                Discord.Intents.FLAGS.GUILD_MESSAGES
            ]
        })
        this.commands = {
            ...this.commands,
            ...this.commands_alias
        }
        this.db = {
            users: usersDB,
            charges: chargesDB,
            market: marketDB
        }
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
            height: 0,
            blocks: new Map(),
            transactions: new Map()
        }
        console.log(`Loaded wallet ${Address.toString(Address.fromPrivateKey(base58.decode(process.env.privateKey)))}`)
        this.tcpClient = TCPApi.createClient()
        this.once('ready', () => {
            this.tcpClient.connect(this.TCP_API.port, this.TCP_API.host, true)
            this.paymentProcessor = new PaymentProcessor(this.db.charges, base58.decode(process.env.privateKey), config.confirmations, true, this.HTTP_API, this.tcpClient)
            this.paymentProcessor.on('charge-pending', async (charge, block) => {
                console.log(`Charge pending: ${charge.address}`)
                if (!block) {
                    const channel = <Discord.TextChannel> this.channels.cache.get(charge.channelId)
                    const message = await channel.send(Client.message.verifying_payment(charge.userId, 0))
                    charge.status = 'PENDING'
                    charge.messageId = message.id
                    await this.paymentProcessor.putCharge(charge)
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
                console.log(`Charge completed: ${charge.address}`)
                const channel = <Discord.TextChannel> this.channels.cache.get(charge.channelId)
                switch (charge?.type) {
                    case 'deposit':
                        const user = await this.getUser(charge.userId)
                        user.credits = beautifyBigInt(parseBigInt(user.credits) + parseBigInt(charge.amount))
                        await this.putUser(user)
                        break
                }
                let received = 0n
                for (const payment of charge.payments) {
                    received += parseBigInt(payment.amount)
                }
                const data = {
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
                console.log(`Charge canceled: ${charge.address}`)
            })
            this.paymentProcessor.on('charge-new', charge => {
                console.log(`Charge new: ${charge.address}, ${charge.amount}`)
            })
            this.paymentProcessor.on('withdraw-all-balance', (code, transaction) => {
                console.log(`Withdrawing all balance from ${base58.encode(transaction.from)}, code: ${code}`)
            })
            this.tcpClient.on('block', block => {
                if (block.height < this.liveFeed.height) return
                this.liveFeed.height = block.height
                this.liveFeed.blocks.forEach(async channelId => {
                    const channel = <Discord.TextChannel> this.channels.cache.get(channelId)
                    channel.send(await Client.message.block(block))
                })
            })
            this.tcpClient.on('transaction', async transaction => {
                this.liveFeed.transactions.forEach(async channelId => {
                    const channel = <Discord.TextChannel> this.channels.cache.get(channelId)
                    channel.send(await Client.message.transaction(transaction))
                })
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
        setTimeout(this.checkCoinbaseCharges.bind(this), 3000)
    }
    checkCoinbaseCharges() {
        const stream = this.db.users.createReadStream()
        const users = []
        stream.on('data', data => {
            if (data.coinbase_charge_code) users.push({ id: data.key, ...data.value })
        })
        stream.on('end', async () => {
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
                    await this.putUser(user)
                }
            }
            setTimeout(this.checkCoinbaseCharges.bind(this), 60000)
        })
    }
    async getUser(id: string) {
        let user = null
        try {
            user = await this.db.users.get(id)
        }
        catch {}
        return user ? { id, ...user } : {
            id,
            credits: '0',
            charge: null,
            coinbase_charge_code: null
        }
    }
    async putUser(user) {
        const id = user.id
        delete user.id
        await this.db.users.put(id, user)
    }
    commands = {
        commands: (message, args) => {
            const commands = Object.keys(this.commands)
            message.reply(commands.join(', '))
        },
        market: async(message, args) => {
            const listings = []
            const stream = this.db.market.createReadStream()
            stream.on('data', data => {
                listings.push({ userId: data.key, ...data.value })
            })
            stream.on('end', () => {
                message.reply(Client.message.listings(listings))
            })
        },
        list: async(message, args) => {
            const type = args.shift()
            if (![ 'sell', 'buy' ].includes(type)) return this.reject(message)
            const price = parseFloat(args.shift())
            if (isNaN(price)) return this.reject(message)
            const data = {
                type,
                price,
                timestamp: Date.now()
            }
            await this.db.market.put(message.author.id, data)
        },
        unlist: async(message, args) => {
            await this.db.market.del(message.author.id)
        },
        marketclear: async(message, args) => {
            if (!this.owners.includes(message.author.id)) return this.reject(message)
            await this.db.market.clear()
        },
        livefeed: async (message, args) => {
            if (!(message.member.permissions.bitfield & 0x8n)) return this.reject(message)
            const type = args.shift()
            if (type === 'blocks') {
                const channelId = this.liveFeed.blocks.get(message.guild.id)
                if (channelId === message.channel.id) {
                    this.liveFeed.blocks.delete(message.channel.id)
                    message.reply('Turned **off** live feed for **blocks**.')
                }
                else if (channelId) {
                    message.reply(`You can only subscribe to **blocks** in one channel per guild.\nCurrently subscribed to **blocks** in: <#${channelId}>`)
                }
                else {
                    this.liveFeed.blocks.set(message.guild.id, message.channel.id)
                    message.reply('Turned **on** live feed for **blocks**.')
                }
            }
            else if (type === 'transactions') {
                const channelId = this.liveFeed.transactions.get(message.guild.id)
                if (channelId === message.channel.id) {
                    this.liveFeed.transactions.delete(message.channel.id)
                    message.reply('Turned **off** live feed for **transactions**.')
                }
                else if (channelId) {
                    message.reply(`You can only subscribe to **transactions** in one channel per guild.\nCurrently subscribed to **transactions** in: <#${channelId}>`)
                }
                else {
                    this.liveFeed.transactions.set(message.guild.id, message.channel.id)
                    message.reply('Turned **on** live feed for **transactions**.')
                }
            }
            else this.reject(message)
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
                message.channel.send({content: `Send${amount ? ' ' + `**${amount}**` : ''} Viscoin to ***${address}***`, files: [{name: "qr.png", attachment: buffer}]})
            }
            catch {
                this.reject(message)
            }
        },
        checksum: (message, args) => {
            try {
                const buffer = base58.decode(args.shift())
                message.react(Address.verifyChecksumAddress(buffer) ? '✅' : '🚫')
            }
            catch {
                this.reject(message)
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
            if (height.toString() !== arg) return this.reject(message)
            const block = await HTTPApi.getBlockByHeight(this.HTTP_API, height)
            message.reply(await Client.message.block(block))
        },
        balance: async (message, args) => {
            const address = args.shift()
            try {
                if (!Address.verifyChecksumAddress(base58.decode(address))) return this.reject(message)
                const balance = await HTTPApi.getBalanceOfAddress(this.HTTP_API, address)
                message.reply(await Client.message.balance(address, balance))
            }
            catch {
                this.reject(message)
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
                this.reject(message)
            }
            catch {
                this.reject(message)
            }
        },
        credits: async (message) => {
            try {
                const mentioned_user = message.mentions.users.first()
                if (mentioned_user) {
                    const user = await this.getUser(mentioned_user.id)
                    return message.reply(Client.message.credits(user.id, user.credits))
                }
                const user = await this.getUser(message.author.id)
                message.reply(Client.message.credits(user.id, user.credits))
            }
            catch (e) { console.log(e)}
        },
        withdraw: async (message, args) => {
            try {
                const user = await this.getUser(message.author.id)
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
                await this.putUser(user)
                const { code, transaction } = await this.paymentProcessor.send(base58.encode(Address.toBuffer(address)), beautifyBigInt(amount))
                console.log(`Withdrawal ${beautifyBigInt(amount)} --> ${address}, code: ${code}, fee: ${transaction.minerFee}`)
                message.channel.send(`**Withdrawal** <@!${message.author.id}>\nWithdrawing **\`${beautifyBigInt(amount)}\`** Viscoin to **\`${address}\`**.\nPlease wait for the network to verify the transaction.`)
            }
            catch (err) {
                console.log(err)
            }
        },
        deposit: async (message, args) => {
            const user = await this.getUser(message.author.id)
            const arg = args.shift()
            if (!arg) {
                const charge = await this.paymentProcessor.getCharge(user.charge)
                if (!charge) return message.reply(`You don't have an active charge!`)
                return message.reply(await Client.message.deposit(charge))
            }
            const amount = parseBigInt(arg)
            if (!amount || amount <= 0n) return message.reply(`Invalid amount!`)
            if (user.charge) {
                // return message.reply(`You already have an active charge!\nDo \`!cancel\` to cancel it.`)
                const charge = await this.paymentProcessor.getCharge(user.charge)
                if ([ 'NEw', 'PENDING' ].includes(charge?.status)) return message.reply(`You already have an active charge!\nDo \`!cancel\` to cancel it.`)
            }
            const charge = await this.paymentProcessor.createCharge(beautifyBigInt(amount), config.chargeExpiresAfter, {
                channelId: message.channel.id,
                userId: message.author.id,
                type: 'deposit'
            })
            console.log(charge)
            user.charge = charge.address
            await this.putUser(user)
            message.reply(await Client.message.deposit(charge))
        },
        cancel: async message => {
            try {
                const user = await this.getUser(message.author.id)
                const canceled = await this.paymentProcessor.cancelCharge(user.charge)
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
                const str = `${color.toUpperCase()}_${base58.encode(crypto.randomBytes(32))}`
                const hash = crypto.createHash('sha256').update(str).digest('hex')
                message.channel.send({
                    embeds: [
                        new Discord.MessageEmbed({
                            description: `Enter **amount** to bet <@!${message.author.id}>\n\`${hash}\``
                        })
                    ]
                })
                const filter = res => res.author.id === message.author.id
                const prompt_amount = await message.channel.awaitMessages({
                    filter,
                    max: 1,
                    time: 30000
                })
                if(!prompt_amount.first()) return message.reply('You took too long to respond! try again')
                const amount = parseBigInt(prompt_amount.first().content.trim())
                if (!amount) return message.reply('Invalid amount!')
                if (amount > parseBigInt(config.maxBet)) return message.reply(`Sorry, your bet is bigger than the maximum allowed bet \`${config.maxBet}\`.`)
                const user = await this.getUser(message.author.id)
                if (!user) return
                if (amount > parseBigInt(user.credits)) return message.reply('You are too poor!')
                message.channel.send({
                    embeds: [
                        new Discord.MessageEmbed({
                            description: `Pick a **color** <@!${message.author.id}>`
                        })
                            .addField(':red_circle: **red**', '**2**x', true)
                            .addField(':green_circle: **green**', '**14**x', true)
                            .addField(':black_circle: **black**', '**2**x', true)
                    ]
                })
                const prompt_color = await message.channel.awaitMessages({
                    filter,
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
                        return message.reply('Invalid color!')
                }
                const credits = parseBigInt(user.credits)
                if (credits < amount) return message.reply('You are too poor!')
                let description = `\n*You can verify that the string below matches the sha256 hash [here](https://emn178.github.io/online-tools/sha256.html).*\n\`${str}\``
                let hex: any = null,
                emoji = null
                switch (color) {
                    case 'red':
                        hex = '#ff0000'
                        emoji = ':red_circle:'
                        break
                    case 'black':
                        hex = '#000000'
                        emoji = ':black_circle:'
                        break
                    case 'green':
                        hex = '#00ff00'
                        emoji = ':green_circle:'
                        break
                }
                if (color === _color) {
                    user.credits = beautifyBigInt(credits - amount + amount * multiplier)
                    await this.putUser(user)
                    description = `${emoji} **You won! \`+${beautifyBigInt(amount * multiplier)}\`** <@!${message.author.id}>` + description
                    message.channel.send({
                        embeds: [
                            new Discord.MessageEmbed({
                                description,
                                color: hex
                            })
                        ]
                    })
                }
                else {
                    user.credits = beautifyBigInt(credits - amount)
                    await this.putUser(user)
                    description = `${emoji} **You lost! \`-${beautifyBigInt(amount)}\`** <@!${message.author.id}>` + description
                    message.channel.send({
                        embeds: [
                            new Discord.MessageEmbed({
                                description,
                                color: hex
                            })
                        ]
                    })
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
                if (mentioned_user.bot) return this.reject(message, `You can't send credits to a bot!`)
                if (mentioned_user.id === message.author.id) return this.reject(message)
                args = args.filter(e => !e.startsWith('<@!'))
                const amount = parseBigInt(args.shift())
                if (!amount || amount <= 0n) return message.reply('Invalid amount!')
                console.log('payment', amount, mentioned_user.id)
                const sender = await this.getUser(message.author.id)
                if (parseBigInt(sender.credits) - amount < 0n) return message.reply('You are too poor!')
                sender.credits = beautifyBigInt(parseBigInt(sender.credits) - amount)
                await this.putUser(sender)
                const receiver = await this.getUser(mentioned_user.id)
                receiver.credits = beautifyBigInt(parseBigInt(receiver.credits) + amount)
                await this.putUser(receiver)
                message.reply(Client.message.pay(amount, message.author.id, mentioned_user.id))
            }
            catch {}
        },
        buy: async (message, args) => {
            if (!this.priceModifier) return message.channel.send('Price not set! Contact owner.')
            const user = await this.getUser(message.author.id)
            const arg = args.shift()
            if (arg) {
                if (user.coinbase_charge_code) {
                    const charge = await Coinbase.retrieveCharge(user.coinbase_charge_code)
                    if (arg.toLowerCase() === 'cancel') {
                        await Coinbase.cancelCharge(charge.code)
                        user.coinbase_charge_code = undefined
                        await this.putUser(user)
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
                await this.putUser(user)
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
            if (!this.owners.includes(message.author.id)) return this.reject(message)
            const price = parseFloat(args.shift())
            if (isNaN(price)) return this.reject(message)
            this.priceModifier = price
            message.react('✅')
            console.log('price', price)
            this.commands.price(message, args)
        },
        bank: async (message, args) => {
            const address = Address.toString(this.paymentProcessor.address())
            const balance = await HTTPApi.getBalanceOfAddress(this.HTTP_API, address)
            message.reply(await Client.message.balance(address, balance === null ? 'Na' : balance))
        },
        hashrate: async (message, args) => {
            const block = await HTTPApi.getLatestBlock(this.HTTP_API)
            const difficulty = block.difficulty
            const hashrate = 2**(difficulty / 16 + 1) / 60
            message.channel.send(`\`approx hashrate: ${hashrate.toPrecision(3)} (${Math.round(hashrate)}) H/s\``)
        },
        difficulty: async(message, args) => {
            const block = await HTTPApi.getLatestBlock(this.HTTP_API)
            const difficulty = block.difficulty
            message.channel.send(`\`difficulty: ${difficulty}\``)
        }
    }
    commands_alias = {
        subscribe: this.commands.livefeed,
        help: this.commands.commands
    }
    static message = {
        listings: (listings) => {
            const embed = new Discord.MessageEmbed({
                title: 'Viscoin Market 🛒',
                // thumbnail: {
                //     url: 'https://cdn.discordapp.com/attachments/858330799627960351/858331288108924938/viscoin.png'
                // }
            })
            const count = listings.length
            listings = listings.sort((a, b) => a.timestamp - b.timestamp).slice(-config.listingsMax)
            const sell = listings.filter(e => e.type === 'sell').sort((a, b) => a.price - b.price)
            const min = sell[0]?.price
            const buy = listings.filter(e => e.type === 'buy').sort((b, a) => a.price - b.price)
            const max = buy[0]?.price
            let sellField = ''
            for (let i = 0; i < sell.length; i++) {
                const listing = sell[i]
                sellField += `<@${listing.userId}> is selling for **$${listing.price}**\n`
            }
            if (sellField) embed.addField('Selling', sellField)
            let buyField = ''
            for (let i = 0; i < buy.length; i++) {
                const listing = buy[i]
                buyField += `<@${listing.userId}> is buying for **$${listing.price}**\n`
            }
            if (buyField) embed.addField('Buying', buyField)
            if (count) embed.setDescription(`There are currently **${count}** listings.\nLowest sell order: ${min ? `**$${min}**` : '**Na**'}\nHighest buy order: ${max ? `**$${max}**` : '**Na**'}`)
            else embed.setDescription('There are currently no listings.')
            return {
                embeds: [
                    embed
                ]
            }
        },
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
        pay: (amount, senderId, receiverId) => {
            const embed = new Discord.MessageEmbed({
                title: 'Payment',
                description: `**\`-${beautifyBigInt(amount)}\`** <@${senderId}>\n**\`+${beautifyBigInt(amount)}\`** <@${receiverId}>`,
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
    reject(message, reply: string | null = null) {
        message.react('🚫')
        if (reply) message.reply(reply)
    }
}
export default Client