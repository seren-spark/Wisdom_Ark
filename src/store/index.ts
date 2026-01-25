import { configureStore } from '@reduxjs/toolkit';
import { combineReducers } from 'redux';
import { persistStore, persistReducer } from 'redux-persist';
import storage from 'redux-persist/lib/storage'; // 默认使用 localStorage
interface SliceModule {
  default: any;
  sliceName?: string; // 可选的自定义名称
}
const sliceModules = import.meta.glob<SliceModule>('./modules/**/*.ts', {
  eager: true, // 同步导入，避免异步复杂性
});
const persistConfig = {
  key: 'root',
  storage,
};
// 自动构建 reducers 对象
const buildReducers = () => {
  const reducers: Record<string, any> = {};
  // console.log(sliceModules);

  Object.entries(sliceModules).forEach(([filePath, module]) => {
    // 从文件路径提取模块名
    const fileName =
      filePath.split('/').pop()?.replace('Slice.ts', '') || 'unknown';
    // 支持自定义 slice 名称
    const sliceName = module.sliceName || fileName;
    // console.log(fileName, sliceName);

    if (module.default) {
      reducers[sliceName] = module.default;
    }
  });
  console.log(reducers);

  return reducers;
};
const rootReducer = combineReducers(buildReducers());
const persistedReducer = persistReducer(persistConfig, rootReducer);

const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
      },
    }),
  //   devTools: process.env.NODE_ENV !== 'production',
});
const persistor = persistStore(store);
export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof store.dispatch;
export { persistor };
export default store;
