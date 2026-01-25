import React from 'react';
import Tiptap from '@/components/Tiptap';
// import MdEditor from './editor/mdEditor';
import { Outlet } from 'react-router-dom';
export default function Editor() {
  return (
    <div id="web-editor">
      <Outlet></Outlet>
    </div>
  );
}
