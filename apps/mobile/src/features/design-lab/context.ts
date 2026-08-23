import { createContext } from 'react';
import type { DesignLabDirection, DesignLabState } from './model';

export const DesignLabContext = createContext<{
  direction: DesignLabDirection;
  state: DesignLabState;
  setDirection: (direction: DesignLabDirection) => void;
  setState: (state: DesignLabState) => void;
}>({ direction: 'quiet', state: 'empty', setDirection: () => {}, setState: () => {} });
