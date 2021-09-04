import * as mongoose from 'mongoose'
const options = {
    id: String,
    inviter: String,
    address: String,
    credits: String,
    coinbase_charge_code: String
}
export default new mongoose.Schema(options, { collection: 'users', versionKey: false })