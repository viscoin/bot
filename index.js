const Discord = require('discord.js')
const viscoin = require('viscoin')
const dotenv = require('dotenv')
const qrcode = require('qrcode')
dotenv.config()
const bot = new Discord.Client({
    intents: [
        Discord.Intents.FLAGS.GUILDS,
        Discord.Intents.FLAGS.GUILD_MESSAGES
    ]
})
const config = {
    prefix: '!'
}
const HTTP_API = process.env.HTTP_API || viscoin.config.default_env.HTTP_API
const host = HTTP_API.split(':').slice(0, -1).join(':')
const port = parseInt(HTTP_API.split(':').reverse()[0])
const embed = {
    block: (block) => {
        const embed = new Discord.MessageEmbed()
        if (block === null) {
            embed.setDescription('Block does not exist')
            return embed
        }
        embed.setColor(block.hash.toString('hex').slice(-6))
        embed.setTimestamp(block.timestamp)
        embed.addField('height', block.height.toString(), true)
        embed.addField('transactions', block.transactions.length.toString(), true)
        embed.addField('difficulty', block.difficulty.toString(), true)
        embed.addField('hash', block.hash.toString('hex'))
        if (block.transactions[0]) embed.addField('miner', viscoin.Address.toString(block.transactions[0].to))
        return embed
    },
    balance: (address, balance) => {
        const embed = new Discord.MessageEmbed()
        embed.setColor(balance === '0' ? 'a30000' : '00a300')
        embed.addField(`address`, address, true)
        if (balance.includes('.')) balance = `**${balance.split('.')[0]}**.${balance.split('.')[1]}`
        else balance = `**${balance}**`
        embed.addField('balance', balance, true)
        return embed
    },
    address: (v1, v2) => {
        const embed = new Discord.MessageEmbed()
        embed.addField('v1 address', v1, true)
        embed.addField('v2 address', v2, true)
        return embed
    }
}
const commands = {
    request: async (message, args) => {
        console.log(args)
        let str = 'https://viscoin.net/#/wallet?'
        const address = args.shift()
        if (address) str += 'to=' + address
        const amount = args.shift()
        if (amount) str += '&amount=' + amount
        const buffer = await qrcode.toBuffer(str, {
            errorCorrectionLevel: 'L'
        })
        message.channel.send({content: `Send${amount ? ' ' + amount : ''} VIS to *${address}*`, files: [{name: "qr.png", attachment: buffer}]})
    },
    checksum: (message, args) => {
        try {
            const buffer = viscoin.base58.decode(args.shift())
            message.react(viscoin.Address.verifyChecksumAddress(buffer) ? '✅' : '🚫')
        }
        catch {
            message.react('🚫')
        }
    },
    block: async (message, args) => {
        const arg = args.shift()
        if (!arg) {
            const block = await viscoin.HTTPApi.getLatestBlock({ host, port })
            console.log(block)
            return message.reply({ embeds: [ embed.block(block) ] })
        }
        try {
            const hash = Buffer.from(arg, 'hex')
            if (Buffer.byteLength(hash) === 32) {
                const block = await viscoin.HTTPApi.getBlockByHash({ host, port }, hash)
                return message.reply({ embeds: [ embed.block(block) ] })
            }
        }
        catch {}
        const height = parseInt(arg)
        if (height.toString() !== arg) return message.react('🚫')
        const block = await viscoin.HTTPApi.getBlockByHeight({ host, port }, height)
        message.reply({ embeds: [ embed.block(block) ] })
    },
    balance: async (message, args) => {
        const arg = args.shift()
        try {
            const balance = await viscoin.HTTPApi.getBalanceOfAddress({ host, port }, arg)
            message.reply({ embeds: [ embed.balance(arg, balance) ] })
        }
        catch {
            message.react('🚫')
        }
    },
    address: (message, args) => {
        const arg = args.shift()
        try {
            const buffer = viscoin.base58.decode(arg)
            if (viscoin.Address.verifyChecksumAddress(buffer)) {
                const v1 = viscoin.base58.encode(viscoin.Address.convertToNormalAddress(buffer))
                return message.reply({ embeds: [ embed.address(v1, arg) ] })
            }
            if (viscoin.isValidAddress(arg)) {
                const v2 = viscoin.base58.encode(viscoin.Address.convertToChecksumAddress(buffer))
                return message.reply({ embeds: [ embed.address(arg, v2) ] })
            }
            message.react('🚫')
        }
        catch {
            message.react('🚫')
        }
    }
}
bot.on('ready', () => console.log(bot.user.tag))
bot.on('messageCreate', message => {
    console.log(`${message.author.tag}: ${message.content}`)
    if (message.author.bot) return
    if (!message.content.startsWith(config.prefix)) return
    const args = message.content.slice(config.prefix.length).trim().split(' ').filter(e => e !== '')
    const command = args.shift()?.toLowerCase()
    if (commands[command]) commands[command](message, args)
})
bot.login(process.env.token)