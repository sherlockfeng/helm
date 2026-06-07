/**
 * Knowledge › Library — PR 1 alias for the existing Roles surface.
 *
 * Per design §3.0, "Role" is reframed as a vertical knowledge collection.
 * The Library page is the browse view; underlying data model is unchanged
 * in PR 1 (PR 2 brings the schema delta). Existing RolesPage is reused
 * here verbatim — UI overhaul lands in later PRs once schema is in place.
 */

export { RolesPage as KnowledgeLibraryPage } from './Roles.js';
