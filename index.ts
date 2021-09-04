import * as dotenv from 'dotenv'
dotenv.config()
import init from './src/mongoose/init'
init()
import Client from './src/Client'
const client = new Client()
client.login(process.env.token)