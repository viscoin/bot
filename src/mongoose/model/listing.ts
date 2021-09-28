import * as mongoose from 'mongoose'
import schema_listing from '../schema/listing'
interface Listing extends mongoose.Document {
    userId: string,
    type: string,
    amount: string,
    price: string,
    timestamp: number
}
export default mongoose.model<Listing>("Listing", schema_listing)