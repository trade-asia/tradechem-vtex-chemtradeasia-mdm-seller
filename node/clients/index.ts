import { IOClients } from '@vtex/api'
import { MdmClient } from './MdmClient'
import { SellerCatalogClient } from './SellerCatalogClient'
import { SellerPricingClient } from './SellerPricingClient'
import { VtexSuggestionsClient } from './VtexSuggestionsClient'

export class Clients extends IOClients {
  public get mdm() {
    return this.getOrSet('mdm', MdmClient)
  }

  public get sellerCatalog() {
    return this.getOrSet('sellerCatalog', SellerCatalogClient)
  }

  public get sellerPricing() {
    return this.getOrSet('sellerPricing', SellerPricingClient)
  }

  public get vtexSuggestions() {
    return this.getOrSet('vtexSuggestions', VtexSuggestionsClient)
  }
}
