import {
  BrowserClient,
  Scope,
  defaultStackParser,
  getDefaultIntegrations,
  makeFetchTransport,
} from '@sentry/browser';

// Millennium runs plugins in Steam's shared JavaScript context. A global
// Sentry.init() would also capture exceptions from Steam and other plugins.
// Keep this client and its scope private, and report only our own failures.
// Sentry recommendation: https://docs.sentry.io/platforms/javascript/best-practices/shared-environments/
const globalIntegrations = new Set([
  'BrowserApiErrors',
  'BrowserSession',
  'Breadcrumbs',
  'ConversationId',
  'FunctionToString',
  'GlobalHandlers',
]);

const client = new BrowserClient({
  dsn: 'https://400d4de2dbd464b022bd5ca56fe77d8b@o4511158959931392.ingest.de.sentry.io/4511575843799120',
  release: 'plugin@1.3.0',
  tracesSampleRate: 0,
  sendDefaultPii: false,
  transport: makeFetchTransport,
  stackParser: defaultStackParser,
  integrations: getDefaultIntegrations({}).filter(
    ({ name }) => !globalIntegrations.has(name),
  ),
});

const scope = new Scope();
scope.setClient(client);
scope.setTag('surface', 'plugin-frontend');
client.init();

/** Only call this from errors raised by Game News code. */
export function reportGameNewsError(error: unknown): void {
  scope.captureException(
    error instanceof Error ? error : new Error(String(error)),
  );
}
