import * as mongoose from 'mongoose'
const options = {
    userId: String,
    type: String,
    amount: String,
    price: String,
    timestamp: Number
}
export default new mongoose.Schema(options, { collection: 'listings', versionKey: false })