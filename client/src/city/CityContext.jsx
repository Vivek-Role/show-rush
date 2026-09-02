import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// The selected city, the way every real booking site has one: chosen once,
// remembered, shown in the header, and used to decide which venues you see.
//
// WHAT THE DATA ACTUALLY SUPPORTS. The seeded catalogue has exactly one cinema,
// "Rush Cinemas, Bengaluru", so Bengaluru is the only city with anything
// scheduled. That is stated here rather than papered over: inventing a list of
// cities the API cannot serve would make the picker a lie the first time
// somebody chose one.
//
// The shape is the part that matters. When the API grows a location on its
// venues, CITIES becomes a fetch and nothing else in the UI has to change.
export const CITIES = [
  {
    name: 'Bengaluru',
    // Matches screens.cinema_name in the seed. The seat map is the only
    // endpoint that returns it today, which is why the shows list cannot yet
    // group by cinema — see ShowsPage.
    supported: true,
  },
];

const STORAGE_KEY = 'show-rush:city';

const CityContext = createContext(null);

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return CITIES.some((city) => city.name === stored) ? stored : CITIES[0].name;
  } catch {
    // A private-mode browser is not a reason to fail to render a page.
    return CITIES[0].name;
  }
}

export function CityProvider({ children }) {
  const [city, setCityState] = useState(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, city);
    } catch {
      // Remembering the choice is a convenience, not a requirement.
    }
  }, [city]);

  const setCity = useCallback((next) => {
    if (CITIES.some((candidate) => candidate.name === next)) setCityState(next);
  }, []);

  const value = useMemo(() => ({ city, setCity, cities: CITIES }), [city, setCity]);

  return <CityContext.Provider value={value}>{children}</CityContext.Provider>;
}

export function useCity() {
  const value = useContext(CityContext);
  if (!value) throw new Error('useCity must be used inside CityProvider');
  return value;
}
