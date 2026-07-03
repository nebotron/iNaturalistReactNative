import { act } from "@testing-library/react-native";
import { clearSuggestionsCache } from "sharedHelpers/suggestionsCache";

import * as mockZustand from "../__mocks__/zustand";

// Reset the Zustand state after every test. See also ../__mocks__/zustand.ts
afterEach( () => {
  act( () => {
    mockZustand.storeResetFns.forEach( resetFn => {
      resetFn();
    } );
  } );
} );

// The CV suggestions cache persists to disk across app restarts, so it isn't
// reset by anything above; clear it explicitly so tests don't see suggestions
// cached by an earlier test.
afterEach( () => {
  clearSuggestionsCache();
} );
