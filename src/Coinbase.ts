import * as fetch from 'node-fetch'
class Coinbase {
    static headers = {
        "Content-Type": "application/json",
        "X-CC-Api-Key": process.env.coinbase,
        "X-CC-Version": "2018-03-22"
    }
    static async listCharges() {
        const req = await fetch("https://api.commerce.coinbase.com/charges", {
            method: "GET",
            headers: this.headers
        })
        try {
            return (await req.json()).data
        }
        catch {
            return null
        }
    }
    static async createCharge({ description, metadata, name, pricing_type, local_price }: { description: string, metadata: object, name: string, pricing_type: string, local_price: any }) {
        const data = {
            description,
            metadata,
            name,
            local_price,
            pricing_type
        }
        const req = await fetch("https://api.commerce.coinbase.com/charges", {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(data)
        })
        try {
            return (await req.json()).data
        }
        catch {
            return null
        }
    }
    static async retrieveCharge(code: string) {
        const req = await fetch(`https://api.commerce.coinbase.com/charges/${code}`, {
            method: "GET",
            headers: this.headers
        })
        try {
            return (await req.json()).data
        }
        catch {
            return null
        }
    }
    static async cancelCharge(code: string) {
        const req = await fetch(`https://api.commerce.coinbase.com/charges/${code}/cancel`, {
            method: "POST",
            headers: this.headers
        })
        try {
            return (await req.json()).data
        }
        catch {
            return null
        }
    }
}
export default Coinbase