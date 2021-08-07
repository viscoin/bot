const Discord = require('discord.js')
const viscoin = require('viscoin')
const dotenv = require('dotenv')
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
        if (block.transactions[0]) embed.addField('miner', viscoin.base58.encode(viscoin.Address.convertToChecksumAddress(block.transactions[0].to)))
        return embed
    },
    balance: (v, address, balance) => {
        const embed = new Discord.MessageEmbed()
        embed.setColor(balance === '0' ? 'a30000' : '00a300')
        embed.addField(`v${v} address`, address, true)
        embed.addField('balance', balance, true)
        return embed
    }
}
const commands = {
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
            const buffer = viscoin.base58.decode(arg)
            if (!viscoin.Address.verifyChecksumAddress(buffer)) {
                if (viscoin.isValidAddress(arg)) {
                    const balance = await viscoin.HTTPApi.getBalanceOfAddress({ host, port }, arg)
                    return message.reply({ embeds: [ embed.balance(1, arg, balance) ] })
                }
                return message.react('🚫')
            }
            const address = viscoin.base58.encode(viscoin.Address.convertToNormalAddress(buffer))
            const balance = await viscoin.HTTPApi.getBalanceOfAddress({ host, port }, address)
            message.reply({ embeds: [ embed.balance(2, address, balance) ] })
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