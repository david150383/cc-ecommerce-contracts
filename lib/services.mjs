/** The platform's services and where their contracts come from. */
export const SERVICES = [
  { name: "auth-service", repo: "ecommerce-auth-service", topic: "auth-events" },
  { name: "product-service", repo: "ecommerce-product-service", topic: null },
  { name: "inventory-service", repo: "ecommerce-inventory-service", topic: "inventory-events", commandQueue: "inventory-commands" },
  { name: "order-service", repo: "ecommerce-order-service", topic: "order-events", commandQueue: "order-commands.fifo" },
  { name: "payment-service", repo: "ecommerce-payment-service", topic: "payment-events", commandQueue: "payment-commands" },
  { name: "notification-service", repo: "ecommerce-notification-service", topic: null, commandQueue: "notification-commands" },
  { name: "saga-orchestrator", repo: "ecommerce-saga-orchestrator", topic: "saga-events" },
];

export const INBOX_QUEUES = { "saga-orchestrator": "saga-inbox", "notification-service": "notification-inbox" };

/**
 * Who calls whose HTTP API (beyond the browser, which uses every public API). The OpenAPI documents
 * do not say who their clients are; this does, for the ownership matrix and for impact analysis.
 */
export const API_CONSUMERS = {
  "auth-service": ["frontend", "order-service (service tokens)", "saga-orchestrator (service tokens)", "payment-service (service tokens)", "every service (JWKS)"],
  "product-service": ["frontend", "order-service (internal price lookup)"],
  "inventory-service": ["frontend"],
  "order-service": ["frontend", "saga-orchestrator (internal: create order)", "payment-service (internal: order amount)"],
  "payment-service": ["frontend", "saga-orchestrator (internal: payment intent)", "payment providers (webhooks)"],
  "notification-service": ["frontend", "auth-service (internal: transactional email)"],
  "saga-orchestrator": ["frontend"],
};
