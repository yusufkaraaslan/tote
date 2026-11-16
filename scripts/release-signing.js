const required={
 darwin:['CSC_LINK','CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'],
 win32:['CSC_LINK','CSC_KEY_PASSWORD'],
 android:['ANDROID_KEYSTORE_PATH','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD'],
 linux:[],
};
function check(platform,env=process.env) {
 if(!Object.hasOwn(required,platform))throw Error('Unknown signing platform');
 const missing=required[platform].filter(key=>!env[key]);
 if(missing.length)throw Error('Missing signing configuration: '+missing.join(', '));
}
if(require.main===module)check(process.argv[2]);
module.exports={check};
