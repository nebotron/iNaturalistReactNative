function install() {
    time npm install 
    time npx pod-install
}

function npr() {
    auth
    time npx react-native run-ios --device --mode Release --no-packager
}

function auth() {
    security unlock-keychain -p banana login.keychain
}

npr || (install && npr)
