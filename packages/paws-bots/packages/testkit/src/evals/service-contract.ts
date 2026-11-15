export const CUSTOMER_SUPPORT_PROVIDERS = {
  salesforce: "SALESFORCE",
  zendesk: "ZENDESK",
} as const;

export const CUSTOMER_SUPPORT_TOOLS = {
  searchAccounts: "SALESFORCE_SEARCH_ACCOUNTS",
  listOpportunities: "SALESFORCE_LIST_OPPORTUNITIES",
  searchOrganizations: "ZENDESK_SEARCH_ORGANIZATIONS",
  listTickets: "ZENDESK_LIST_TICKETS",
} as const;
