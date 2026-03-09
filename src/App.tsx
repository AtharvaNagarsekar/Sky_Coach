import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Footer from './components/Footer';
import LiveATC from './pages/LiveATC';
import VoiceAnalyzer from './pages/VoiceAnalyzer';
import TrainingSimulator from './pages/TrainingSimulator';
import './index.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar />
        <div className="app-main">
          <div className="page-content">
            <Routes>
              <Route path="/" element={<Navigate to="/live-atc" replace />} />
              <Route path="/live-atc" element={<LiveATC />} />
              <Route path="/voice-analyzer" element={<VoiceAnalyzer />} />
              <Route path="/simulator" element={<TrainingSimulator />} />
            </Routes>
          </div>
          <Footer />
        </div>
      </div>
    </BrowserRouter>
  );
}