import * as mongoose from 'mongoose'
export default () => {
    mongoose.set("useFindAndModify", false)
    mongoose.connection.on("connected", () => {
        console.log("Mongoose connection successfully opened!")
    })
    mongoose.connection.on("err", err => {
        console.error(`Mongoose connection error:\n${err.stack}`)
    })
    mongoose.connection.on("disconnected", () => {
        console.log("Mongoose connection disconnected")
    })
    mongoose.connect("mongodb://localhost:27017/bot", {
        useNewUrlParser: true,
        autoIndex: false,
        poolSize: 5,
        connectTimeoutMS: 10000,
        useUnifiedTopology: true
    })
}