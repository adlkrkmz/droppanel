import dotenv from 'dotenv'
dotenv.config()
import { getValidAccessToken } from '../modules/ebayOAuth/ebayOAuthService'

async function main() {
  const token = await getValidAccessToken('00000000-0000-0000-0000-000000000001', 'S1', false)
  const url = 'https://api.ebay.com/sell/inventory/v1/offer?limit=10&offset=0'
  console.log('Testing URL:', url)
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US'
    }
  })
  console.log('Status:', res.status)
  const body = await res.text()
  console.log('Response:', body.slice(0, 500))
}

main().catch(console.error)

