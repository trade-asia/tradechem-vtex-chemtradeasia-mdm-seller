import { Service, ServiceContext, ParamsContext, RecorderState, method } from '@vtex/api'
import { Clients } from './clients'
import { getSellerProducts, getSellerCountries } from './handlers/sellerProductsHandler'
import { getSellerDocuments, uploadSellerDocument, deleteSellerDocument } from './handlers/sellerDocumentsHandler'
import { devReadSettings, devSaveSettings, devDeleteSettings } from './handlers/devSettingsHandler'
import { catalogCapture, manualCapture, listMyProducts, captureEventLog } from './handlers/productCaptureHandler'
import { createSubscriptionCheckout, stripeWebhookHandler, getSubscriptionStatus, initEmbeddedSubscription } from './handlers/subscriptionHandler'
import { getMySubscription, getMySubscriptionPlans, getMySubscriptionInvoices, initMdmSubscriptionCheckout } from './handlers/mdmSubscriptionHandler'
import { logsHub } from './handlers/logsHubHandler'
import { debugAdminToken } from './handlers/debugAdminTokenHandler'

declare global {
  type Context = ServiceContext<Clients, State>

  interface State extends RecorderState {
    code: number
  }
}

export default new Service<Clients, State, ParamsContext>({
  clients: {
    implementation: Clients,
    options: {
      default: {
        retries: 2,
        timeout: 10000,
      },
    },
  },
  events: {
    catalogChange: [catalogCapture],
  },
  routes: {
    sellerProducts: method({ GET: [getSellerProducts] }),
    sellerCountries: method({ GET: [getSellerCountries] }),
    sellerDocuments: method({ GET: [getSellerDocuments], POST: [uploadSellerDocument] }),
    sellerDocumentDelete: method({ POST: [deleteSellerDocument] }),
    devSettings: method({ GET: [devReadSettings], POST: [devSaveSettings], DELETE: [devDeleteSettings] }),
    manualCapture: method({ GET: [manualCapture] }),
    myProducts: method({ GET: [listMyProducts] }),
    captureEvents: method({ GET: [captureEventLog] }),
    subscriptionCheckout: method({ POST: [createSubscriptionCheckout] }),
    subscriptionWebhook: method({ POST: [stripeWebhookHandler] }),
    subscriptionStatus: method({ GET: [getSubscriptionStatus] }),
    subscriptionEmbedInit: method({ POST: [initEmbeddedSubscription] }),
    mdmSubscription: method({ GET: [getMySubscription] }),
    mdmSubscriptionPlans: method({ GET: [getMySubscriptionPlans] }),
    mdmSubscriptionInvoices: method({ GET: [getMySubscriptionInvoices] }),
    logsHub: method({ GET: [logsHub] }),
    debugAdminToken: method({ GET: [debugAdminToken] }),
    mdmSubscriptionCheckout: method({ POST: [initMdmSubscriptionCheckout] }),
  },
})
