/**
 * Knowledge › Sources — PR 1 alias for the existing Subscriptions surface.
 *
 * Per design §7.4, Sources unifies the pull (Subscriptions) and push
 * (Mirrors) sides of knowledge sharing. PR 1 reuses the current
 * SubscriptionsPage; the dedicated bi-directional UI with sync-status
 * badges (§5.5) lands in PR 5.5a–e.
 */

export { SubscriptionsPage as KnowledgeSourcesPage } from './Subscriptions.js';
