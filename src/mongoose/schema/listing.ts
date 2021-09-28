import * as mongoose from 'mongoose'
const options = {
    userId: String,
    type: String,
    price: Number,
    timestamp: Number
}
export default new mongoose.Schema(options, { collection: 'listings', versionKey: false })