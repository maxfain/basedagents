import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { posts } from '../blog';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function Blog(): React.ReactElement {
  useEffect(() => {
    document.title = 'Blog — BasedAgents';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', 'Insights on AI agent identity, trust, and the agentic web from the BasedAgents team.');
  }, []);

  return (
    <div className="container" style={{ paddingTop: 64, paddingBottom: 64 }}>
      <div style={{ marginBottom: 48 }}>
        <h1 style={{ marginBottom: 8 }}>Blog</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 16 }}>
          Insights on AI agent identity, trust, and the agentic web
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {posts.map((post) => (
          <Link
            key={post.slug}
            to={`/blog/${post.slug}`}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <article
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: 28,
                transition: 'border-color 150ms ease',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <h2 style={{ fontSize: 22, marginBottom: 4 }}>{post.title}</h2>
              {post.subtitle && (
                <p style={{ color: 'var(--accent)', fontSize: 15, marginBottom: 12, fontWeight: 500 }}>
                  {post.subtitle}
                </p>
              )}
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
                {post.description}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{post.author}</span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{formatDate(post.publishedAt)}</span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{post.readingTime} min read</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {post.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        background: 'var(--accent-muted)',
                        color: 'var(--accent)',
                        fontSize: 12,
                        padding: '2px 10px',
                        borderRadius: 12,
                        fontWeight: 500,
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          </Link>
        ))}
      </div>
    </div>
  );
}
