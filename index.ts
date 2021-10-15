import * as dotenv from 'dotenv'
dotenv.config()
import * as level from 'level'
import Client from './src/Client'
import * as fs from 'fs'

if (!fs.existsSync('./db')) fs.mkdirSync('./db')
const charges = level('./db/charges', { keyEncoding: 'utf8', valueEncoding: 'json' })
const users = level('./db/users', { keyEncoding: 'utf8', valueEncoding: 'json' })
const market = level('./db/market', { keyEncoding: 'utf8', valueEncoding: 'json' })
const guilds = level('./db/guilds', { keyEncoding: 'utf8', valueEncoding: 'json' })
const client = new Client(charges, users, market, guilds)
client.login(process.env.token)