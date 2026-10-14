import { View } from "react-native";

export const FasterImageView = View;
export const clearCache = jest.fn( () => Promise.resolve() );
export const prefetch = jest.fn( ( _sources: string[] ) => Promise.resolve() );
