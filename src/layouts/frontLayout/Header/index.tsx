// 接收1.headerMenu,
import type React from 'react';
import './index.scss';
import {
  Layout,
  Menu,
  Row,
  theme,
  Col,
  type MenuProps,
  Input,
  Dropdown,
  Space,
  Badge,
  message,
  Button,
} from 'antd';

import { NavLink, useNavigate } from 'react-router-dom';

import { BellFilled, CaretDownFilled } from '@ant-design/icons';

import { useScrollVisibility } from '@/hooks/useScrollVisibility';

import UserDropdown from '@/components/UserDropdown';
import LoginRegisterModal from '@/components/LoginForm';
import { useAuth } from '@/contexts/authContext';
import LoginRequiredButton from '@/components/LoginRequiredButton';

type MenuItem = Required<MenuProps>['items'][number];
interface MyHeaderProps {
  headMenu?: MenuItem[];
  children?: React.ReactNode;
}
const { Header } = Layout;
const { Search } = Input;

// 默认头部菜单
const defaultHeadMenu: MenuItem[] = [
  {
    key: '/',
    label: '首页',
  },
  {
    key: '/pins',
    label: '沸点',
  },
  {
    key: '/dowbload',
    label: '下载',
  },
  {
    key: '/live',
    label: '直播',
  },
  {
    key: '/ai',
    label: 'AI',
  },
  {
    key: '/livevideo',
    label: '直播测试Hbr',
  },
  {
    key: '/editor/draft',
    label: '编辑器',
  },
];
// 创作者中心菜单
const items = [
  {
    key: '1',
    label: '写文章',
  },
  {
    key: '2',
    label: '写沸点',
  },
];

const messageItems: MenuProps['items'] = [
  {
    key: '1',
    label: (
      <NavLink target="_blank" rel="noopener noreferrer" to="/notification">
        评论
      </NavLink>
    ),
  },
  {
    key: '2',
    label: (
      <NavLink target="_blank" rel="noopener noreferrer" to="/notification">
        赞和收藏
      </NavLink>
    ),
  },
  {
    key: '3',
    label: (
      <a
        target="_blank"
        rel="noopener noreferrer"
        href="https://www.luohanacademy.com"
      >
        私信
      </a>
    ),
  },
  {
    key: '3',
    label: (
      <a
        target="_blank"
        rel="noopener noreferrer"
        href="https://www.luohanacademy.com"
      >
        系统通知
      </a>
    ),
  },
];
export default function MyHeader(props?: MyHeaderProps) {
  const { headMenu } = props || {};
  // const { token } = useToken();
  const { requireAuth, isLoggedIn } = useAuth();
  const menuStyle: React.CSSProperties = {
    boxShadow: 'none',
  };

  const {
    token: {
      colorBgContainer,
      colorBgElevated,
      borderRadiusLG,
      boxShadowSecondary,
    },
  } = theme.useToken();
  // const contentStyle: React.CSSProperties = {
  // backgroundColor: token.colorBgElevated,
  // borderRadius: token.borderRadiusLG,
  // boxShadow: token.boxShadowSecondary,
  // };
  const handleMenu: MenuProps['onClick'] = (e) => {
    navigate(e.key);
  };
  const navigate = useNavigate();
  const visible = useScrollVisibility();
  const handleLoginModal = () => {
    console.log('点了');

    requireAuth(() => {
      message.success('点赞成功');
    });
  };

  return (
    <Header
      className={`myHeader ${visible ? '' : 'hide'}`}
      style={{
        background: colorBgContainer,
      }}
    >
      <Row className=" header-container max-w-[1440px] w-full">
        {/* logo */}
        <Col span={4} className="flex-center">
          <div className="logo flex-center">
            <img src="/logo.png" alt="" />
          </div>
        </Col>
        {/* 导航菜单 */}
        <Col span={20}>
          <Row>
            <Col span={12}>
              {!props?.children && (
                <Menu
                  selectedKeys={[location.pathname]}
                  onClick={handleMenu}
                  mode="horizontal"
                  items={headMenu || defaultHeadMenu}
                />
              )}
              {props?.children}
            </Col>

            {/* 右侧菜单 */}
            <Col
              span={12}
              className="flex-center"
              style={{ alignItems: 'center', display: 'flex' }}
            >
              <Space align="center" style={{ width: '100%' }} size="middle">
                <Search className="top-search" placeholder="搜索" allowClear />

                <Dropdown.Button
                  type="primary"
                  menu={{ items }}
                  icon={<CaretDownFilled />}
                >
                  创作者中心
                </Dropdown.Button>

                {isLoggedIn ? (
                  <>
                    <Dropdown menu={{ items: messageItems }}>
                      <Badge count={1} size="small" onClick={handleLoginModal}>
                        <BellFilled
                          style={{
                            fontSize: '20px',
                            color: `#8a919f`,
                          }}
                        />
                      </Badge>
                    </Dropdown>

                    <UserDropdown></UserDropdown>
                  </>
                ) : (
                  <>
                    <LoginRequiredButton color="primary" variant="outlined">
                      登录/注册
                    </LoginRequiredButton>
                  </>
                )}
              </Space>
            </Col>
          </Row>
        </Col>
      </Row>
    </Header>
  );
}
