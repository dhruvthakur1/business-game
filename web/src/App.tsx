import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { GameProvider } from './state/game';
import { Bank } from './screens/Bank';
import { BuildingDetail } from './screens/BuildingDetail';
import { Catalog } from './screens/Catalog';
import { Contests } from './screens/Contests';
import { Contracts } from './screens/Contracts';
import { Designer } from './screens/Designer';
import { Headquarters } from './screens/Headquarters';
import { Landing } from './screens/Landing';
import { Leagues } from './screens/Leagues';
import { Market } from './screens/Market';
import { Onboarding } from './screens/Onboarding';
import { Research } from './screens/Research';
import { Showroom } from './screens/Showroom';
import { SignIn } from './screens/SignIn';
import { Season } from './screens/Season';

function NotFound() {
  return (
    <div className="stack" style={{ padding: 48, alignItems: 'flex-start' }}>
      <h1 className="h-page">Nothing on this plot</h1>
      <Link to="/app" className="btn btn-primary">Back to Headquarters</Link>
    </div>
  );
}

export function App() {
  return (
    <GameProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/start" element={<Onboarding />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Headquarters />} />
            <Route path="buildings/:id" element={<BuildingDetail />} />
            <Route path="market" element={<Market />} />
            <Route path="contracts" element={<Contracts />} />
            <Route path="designer" element={<Designer />} />
            <Route path="research" element={<Research />} />
            <Route path="bank" element={<Bank />} />
            <Route path="leagues" element={<Leagues />} />
            <Route path="contests" element={<Contests />} />
            <Route path="contests/:id" element={<Contests />} />
            <Route path="showroom" element={<Showroom />} />
            <Route path="season" element={<Season />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </GameProvider>
  );
}
