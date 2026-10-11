import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { connect } from './ws.js';

connect(); // deschidem WebSocket-ul către backend înainte de primul render
createRoot(document.getElementById('root')).render(<App />);
