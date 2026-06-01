let isRunning = false;

export const isBackgroundUploadTaskRunning = ( ) => isRunning;

export const beginBackgroundUploadTask = async ( ): Promise<boolean> => {
  isRunning = true;
  return true;
};

export const endBackgroundUploadTask = async ( ) => {
  isRunning = false;
};
