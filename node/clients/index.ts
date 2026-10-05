import { IOClients } from '@vtex/api'
import { MdmClient } from './MdmClient'
import { SellerCatalogClient } from './SellerCatalogClient'

export class Clients extends IOClients {
  public get mdm() {
    return this.getOrSet('mdm', MdmClient)
  }

  public get sellerCatalog() {
    return this.getOrSet('sellerCatalog', SellerCatalogClient)
  }
}
