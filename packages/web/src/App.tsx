import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Landing from './pages/Landing';
import Directory from './pages/Directory';
import AgentProfile from './pages/AgentProfile';
import ChainExplorer from './pages/ChainExplorer';
import GettingStarted from './pages/GettingStarted';
import Status from './pages/Status';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';

export default function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/agents" element={<Directory />} />
          <Route path="/agents/:id" element={<AgentProfile />} />
          <Route path="/chain" element={<ChainExplorer />} />
          <Route path="/docs/getting-started" element={<GettingStarted />} />
          <Route path="/status" element={<Status />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
