import { QueryClient } from "@tanstack/react-query";

// Shared by the render helpers, and cleared after each test
const queryClient = new QueryClient( {
  defaultOptions: {
    queries: {
      // No need to do default retries in tests
      retry: false,
      // Prevent `Jest did not exit one second after the test run has completed.` error
      // https://react-query-v3.tanstack.com/guides/testing#set-cachetime-to-infinity-with-jest
      gcTime: Infinity,
    },
  },
} );

export default queryClient;
