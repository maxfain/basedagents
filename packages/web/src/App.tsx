import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Landing from './pages/Landing';
import Directory from './pages/Directory';
import AgentProfile from './pages/AgentProfile';
import ChainExplorer from './pages/ChainExplorer';
import GettingStarted from './pages/GettingStarted';
import Status from './pages/Status';
import Whois from './pages/Whois';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Register from './pages/Register';
import Integrations from './pages/Integrations';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';
import { AgentAuthProvider } from './hooks/useAgentAuth';

export default function App(): React.ReactElement {
  return (
    <AgentAuthProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Directory />} />
          <Route path="/agents" element={<Directory />} />
          <Route path="/agents/:id" element={<AgentProfile />} />
          <Route path="/agent/:name" element={<AgentProfile />} />
          <Route path="/chain" element={<ChainExplorer />} />
          <Route path="/docs/getting-started" element={<GettingStarted />} />
          <Route path="/status" element={<Status />} />
          <Route path="/whois" element={<Whois />} />
          <Route path="/register" element={<Register />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
        </Routes>
      </Layout>
    </BrowserRouter>
    </AgentAuthProvider>
  );
}
