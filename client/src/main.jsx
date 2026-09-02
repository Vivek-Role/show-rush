import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { CityProvider } from './city/CityContext.jsx';
import { App } from './App.jsx';
import './app.css';

// StrictMode double-invokes effects in development only, so the session check
// in AuthProvider runs twice locally. It is a plain GET with no side effects,
// and the production build runs it once.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <CityProvider>
          <App />
        </CityProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
