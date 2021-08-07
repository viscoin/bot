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
const commands = {
    checksum: (message, args) => {
        const buffer = viscoin.base58.decode(args.shift())
        message.react(viscoin.Address.verifyChecksumAddress(buffer) ? '✅' : '🚫')
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