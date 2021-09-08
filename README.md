[![Discord](https://img.shields.io/discord/840244262615515148?label=Viscoin&logo=discord&style=for-the-badge)](https://discord.gg/viscoin)

# Viscoin Discord Bot

A bot that bridges Viscoin to Discord.

## Installation
```
git clone https://github.com/viscoin/bot
npm install
```

## Usage

### Environment Variables

Create a .env file in the root directory of the project and set following values.
```
token="discord_bot_token"
privateKey="wallet_private_key"
coinbase="coinbase_api_key"
HTTP_API="viscoin_node_ip_address:80"
TCP_API="viscoin_node_ip_address:9332"
```

### MongoDB

Setup MongoDB either locally through the traditional installer or via docker. It is also possible to connect to a remote db by changing the value of connectionString in config.json.

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.