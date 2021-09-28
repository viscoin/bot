import * as mongoose from 'mongoose'
import schema_listing from '../schema/listing'
interface Listing extends mongoose.Document {
    userId: string,
    type: string,
    price: number,
    timestamp: number
}
export default mongoose.model<Listing>("Listing", schema_listing)