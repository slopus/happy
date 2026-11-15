/** The billing provider no longer has this customer, e.g. it was deleted in the vendor's dashboard. */
export class BillingCustomerNotFoundError extends Error {
  readonly code = "BILLING_CUSTOMER_NOT_FOUND";
  constructor(options?: { cause?: unknown }) {
    super("Billing customer no longer exists", options);
    this.name = "BillingCustomerNotFoundError";
  }
}

/** The card was declined or needs the cardholder to confirm, so nothing was charged. */
export class BillingPaymentNotCompletedError extends Error {
  readonly code = "BILLING_PAYMENT_NOT_COMPLETED";
  constructor(options?: { cause?: unknown }) {
    super("The card was not charged", options);
    this.name = "BillingPaymentNotCompletedError";
  }
}

/** An earlier checkout completed while a new one was being opened; another would bill twice. */
export class BillingCheckoutCompletedError extends Error {
  readonly code = "BILLING_CHECKOUT_COMPLETED";
  constructor() {
    super("An earlier checkout has already completed");
    this.name = "BillingCheckoutCompletedError";
  }
}

/** The customer has no monthly credit plan to change, e.g. it ended after the page loaded. */
export class BillingNoMonthlyCreditsError extends Error {
  readonly code = "BILLING_NO_MONTHLY_CREDITS";
  constructor() {
    super("No monthly credit subscription");
    this.name = "BillingNoMonthlyCreditsError";
  }
}
