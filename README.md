[![Discord](https://img.shields.io/discord/840244262615515148?label=Viscoin&logo=discord&style=for-the-badge)](https://discord.gg/viscoin)

# Viscoin Discord Bot

A bot that bridges Viscoin to Discord.

## Installation
1. `git clone https://github.com/viscoin/bot`
2. `cd bot`
3. `npm run setup`

### Environment Variables

Create a .env file in the root directory of the project and set following values.
```json
token="discord_bot_token"
privateKey="wallet_private_key"
coinbase="coinbase_api_key"
owners="userId's separated by comma (,)"
HTTP_API="viscoin_node_ip_address:80"
TCP_API="viscoin_node_ip_address:9332"
```

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.