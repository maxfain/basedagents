/**
 * Entry of the lazily loaded Agent Atlas chunk (App.tsx → React.lazy). Every
 * atlas route renders this component; it resolves the pathname with the same
 * resolver the prerender and <head> builder use.
 */
import React from 'react';
import { useLocation } from 'react-router-dom';
import { resolveAtlas } from './resolve';
import { useAtlasHead } from './useAtlasHead';
import Landing from './pages/Landing';
import ProjectPage from './pages/Project';
import { CategoriesHub, CategoryPage, GuidesHub, ProtocolsHub } from './pages/Hubs';
import { ComparisonPage, GuidePage } from './pages/GuideComparison';
import { FaqPage, FormPage, GlossaryPage, NotFoundPage, StaticPage } from './pages/Reference';

export default function AtlasPage(): React.ReactElement {
  const { pathname, search } = useLocation();
  const r = resolveAtlas(pathname);
  useAtlasHead(pathname, search);

  switch (r.kind) {
    case 'home': return <Landing r={r} />;
    case 'categories': return <CategoriesHub r={r} />;
    case 'category': return <CategoryPage r={r} />;
    case 'protocols': return <ProtocolsHub r={r} />;
    case 'guides': return <GuidesHub r={r} />;
    case 'guide': return <GuidePage r={r} />;
    case 'comparison': return <ComparisonPage r={r} />;
    case 'project': return <ProjectPage r={r} />;
    case 'glossary': return <GlossaryPage r={r} />;
    case 'faq': return <FaqPage r={r} />;
    case 'static': return <StaticPage r={r} />;
    case 'form': return <FormPage r={r} />;
    case 'not-found': return <NotFoundPage r={r} />;
  }
}
