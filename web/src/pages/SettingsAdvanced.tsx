/**
 * Settings › Advanced — opt-in surfaces hidden from the main IA.
 *
 * Per design §2 (sidebar IA reduction) and §13.1 (migration UX), the
 * Approvals / Harness / Lark bindings surfaces remain fully functional
 * but are no longer top-level nav entries. They live here, opted-in by
 * the user via the `helm.ui.advanced` localStorage flag.
 *
 * PR 1 keeps the implementation deliberately small: this page is a
 * landing hub that links to the existing pages. Later PRs may absorb
 * functionality directly when it stops making sense as its own surface.
 *
 * Why localStorage and not config.json: the flag is renderer-only UI
 * state; touching the backend config schema for a navigation toggle is
 * overkill, and it lets us migrate users via §13 first-launch card
 * without round-tripping through the API.
 */

import { Link } from 'react-router-dom';
import { Card } from '../components/Card.js';
import { PageHeader } from '../components/PageHeader.js';
import { isAdvancedEnabled, setAdvancedEnabled } from '../lib/advanced-flag.js';
import { useState } from 'react';
import { Button } from '../components/Button.js';

export function SettingsAdvancedPage() {
  const [enabled, setEnabled] = useState<boolean>(isAdvancedEnabled());

  const toggle = (): void => {
    const next = !enabled;
    setAdvancedEnabled(next);
    setEnabled(next);
  };

  return (
    <div className="helm-page">
      <PageHeader
        title="Advanced surfaces"
        subtitle="Lesser-used modules kept out of the main sidebar. Enable to see them in nav; the routes work regardless."
      />

      <Card>
        <h3>Sidebar visibility</h3>
        <p className="muted">
          When on, the sidebar shows the Advanced section with Approvals,
          Harness, and Lark bindings. When off, the pages still work via
          direct URL but don&apos;t clutter the main nav.
        </p>
        <Button
          onClick={toggle}
          variant={enabled ? 'default' : 'primary'}
          aria-pressed={enabled}
        >
          {enabled ? 'Disable Advanced sidebar entries' : 'Enable Advanced sidebar entries'}
        </Button>
      </Card>

      <Card>
        <h3>Pages</h3>
        <ul className="helm-advanced-links">
          <li>
            <Link to="/approvals">Approvals</Link>
            <span className="muted"> — tool-use approval queue from Cursor hooks.</span>
          </li>
          <li>
            <Link to="/bindings">Lark bindings</Link>
            <span className="muted"> — channel ↔ chat bridge for remote conversations.</span>
          </li>
          <li>
            <Link to="/harness">Harness</Link>
            <span className="muted"> — multi-stage feature-development workflow.</span>
          </li>
          <li>
            <Link to="/campaigns">Campaigns</Link>
            <span className="muted"> — multi-cycle product/dev/test orchestration (legacy).</span>
          </li>
          <li>
            <Link to="/requirements">Requirements</Link>
            <span className="muted"> — requirements capture sessions (legacy).</span>
          </li>
        </ul>
      </Card>
    </div>
  );
}
