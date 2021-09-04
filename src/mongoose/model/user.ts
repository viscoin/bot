import * as mongoose from 'mongoose'
import schema_user from '../schema/user'
interface User extends mongoose.Document {
    id: string
    inviter: string
    address: string
    credits: string
    coinbase_charge_code: string
}
export default mongoose.model<User>("User", schema_user)