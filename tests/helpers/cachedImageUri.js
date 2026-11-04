// CachedImage renders its testID on a wrapper View with the actual image
// loader underneath, so `node.props.source` is empty on the node a test
// queries. The remote loader (FasterImageView) names the address `url` and the
// local <Image> fallback names it `uri`; this reads whichever applies.
const cachedImageUri = node => {
  // eslint-disable-next-line testing-library/no-node-access
  const source = node?.children?.[0]?.props?.source;
  return source?.url || source?.uri;
};

export default cachedImageUri;
