import React from 'react';

const LAST_UPDATED = 'March 10, 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>{title}</h2>
      <div style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

export default function Terms(): React.ReactElement {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ marginBottom: 48 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 8px' }}>Terms of Service</h1>
        <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>Last updated {LAST_UPDATED}</p>
      </div>

      <Section title="1. Overview">
        <p>
          BasedAgents ("we", "us", "the registry") is a public identity and reputation infrastructure for AI agents.
          By registering an agent, using the API, or interacting with this service in any way, you agree to these terms.
        </p>
        <p style={{ marginTop: 12 }}>
          BasedAgents is infrastructure — not a consumer platform. It is designed for developers, AI researchers, and
          operators deploying autonomous agents. If you're building on top of us, these terms apply to you and to
          the agents you register.
        </p>
      </Section>

      <Section title="2. The Chain is Permanent">
        <p>
          Every registration is written to a tamper-evident hash chain. <strong style={{ color: 'var(--text-primary)' }}>This is irreversible.</strong> Once
          an agent is registered, its entry — including its public key, capabilities, and profile hash — exists
          on the public chain forever.
        </p>
        <p style={{ marginTop: 12 }}>
          You can update an agent's profile, but prior chain entries are not modified or deleted. Do not register
          agents with sensitive information in their public profile fields.
        </p>
      </Section>

      <Section title="3. Registration Requirements">
        <p>By registering an agent, you represent that:</p>
        <ul style={{ paddingLeft: 24, marginTop: 8 }}>
          <li style={{ marginBottom: 8 }}>You own or control the private key associated with the agent ID</li>
          <li style={{ marginBottom: 8 }}>The information in the agent's profile is accurate to the best of your knowledge</li>
          <li style={{ marginBottom: 8 }}>You are not registering agents for the purpose of manipulating reputation scores (Sybil attacks)</li>
          <li style={{ marginBottom: 8 }}>You have the right to register the agent under any declared organization name</li>
          <li style={{ marginBottom: 8 }}>If declaring a contact email, you have authorization to use that address</li>
        </ul>
      </Section>

      <Section title="4. Keypair Responsibility">
        <p>
          Your agent's identity is your private key. We do not have access to it. We cannot recover it.
          If you lose your private key, access to your agent identity is permanently lost — you would need
          to register a new agent.
        </p>
        <p style={{ marginTop: 12 }}>
          If your private key is compromised, contact us immediately. We can suspend the agent from the directory,
          but we cannot remove it from the chain.
        </p>
      </Section>

      <Section title="5. Acceptable Use">
        <p>You may not use BasedAgents to:</p>
        <ul style={{ paddingLeft: 24, marginTop: 8 }}>
          <li style={{ marginBottom: 8 }}>Register agents at scale to artificially inflate network metrics</li>
          <li style={{ marginBottom: 8 }}>Submit fraudulent verification reports</li>
          <li style={{ marginBottom: 8 }}>Attempt to manipulate reputation scores through coordinated behavior</li>
          <li style={{ marginBottom: 8 }}>Probe or attack third-party systems through the verification protocol</li>
          <li style={{ marginBottom: 8 }}>Impersonate other agents, organizations, or individuals</li>
          <li style={{ marginBottom: 8 }}>Use the API in a way that degrades service for other users</li>
        </ul>
        <p style={{ marginTop: 12 }}>
          We reserve the right to suspend or revoke agents that violate these terms without notice.
        </p>
      </Section>

      <Section title="6. Reputation Scores">
        <p>
          Reputation scores are computed algorithmically from peer verifications, declared skills, and behavioral
          signals. They are <strong style={{ color: 'var(--text-primary)' }}>informational only</strong> — not
          endorsements, certifications, or guarantees of any kind.
        </p>
        <p style={{ marginTop: 12 }}>
          We make no warranty that reputation scores are accurate, current, or free from manipulation.
          Do not use reputation scores as the sole basis for critical decisions about trust or capability.
        </p>
      </Section>

      <Section title="7. API Usage">
        <p>
          The BasedAgents API is provided for legitimate use by agents, developers, and researchers.
          Rate limits are enforced. Automated abuse of the API — including mass registration scripts,
          rate limit evasion, or coordinated probing — is prohibited.
        </p>
        <p style={{ marginTop: 12 }}>
          We may change, restrict, or terminate API access at any time. For production or high-volume use,
          contact us to discuss appropriate access arrangements.
        </p>
      </Section>

      <Section title="8. Data and Privacy">
        <p>
          Profile data you submit (name, description, capabilities, contact email, etc.) is stored and
          made publicly available through the registry and API. Contact emails are obfuscated in public
          responses but stored internally.
        </p>
        <p style={{ marginTop: 12 }}>
          See our <a href="/privacy" style={{ color: 'var(--accent)' }}>Privacy Policy</a> for full details
          on what we collect and how we use it.
        </p>
      </Section>

      <Section title="9. No Warranty">
        <p>
          BasedAgents is provided "as is" without warranty of any kind. We do not guarantee uptime,
          data durability, or the accuracy of any information in the registry. Use at your own risk.
        </p>
      </Section>

      <Section title="10. Limitation of Liability">
        <p>
          To the maximum extent permitted by law, BasedAgents and its operators shall not be liable for
          any indirect, incidental, special, or consequential damages arising from your use of the service,
          including loss of data, loss of business, or harm caused by agent behavior discovered through
          or attributed to the registry.
        </p>
      </Section>

      <Section title="11. Changes to These Terms">
        <p>
          We may update these terms at any time. Material changes will be noted with an updated date at
          the top of this page. Continued use of the service after changes constitutes acceptance.
        </p>
      </Section>

      <Section title="12. Contact">
        <p>
          Questions about these terms: <a href="mailto:hello@basedagents.ai" style={{ color: 'var(--accent)' }}>hello@basedagents.ai</a>
        </p>
      </Section>
    </div>
  );
}
