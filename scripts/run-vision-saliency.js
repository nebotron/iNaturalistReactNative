const { spawnSync } = require( "node:child_process" );
const path = require( "node:path" );

const repoRoot = path.join( __dirname, ".." );
const toolRoot = path.join( repoRoot, "tools", "inat_vision_saliency" );
const py = process.env.VISION_SALIENCY_PYTHON || "python3";

const result = spawnSync(
  py,
  ["-m", "inat_vision_saliency", ...process.argv.slice( 2 )],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONPATH: [toolRoot, process.env.PYTHONPATH].filter( Boolean ).join( path.delimiter ),
    },
  },
);

process.exit( result.status === null ? 1 : result.status );
