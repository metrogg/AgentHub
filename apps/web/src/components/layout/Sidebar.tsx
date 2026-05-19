import {
  Box,
  ButtonBase,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import HubIcon from '@mui/icons-material/Hub'
import { useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useSessionStore } from '../../stores/sessionStore'
import {
  evaluationItems,
  observabilityItems,
  primitiveItems,
  runtimeItems,
  type StudioNavItem,
  utilityItems,
} from '../../features/studio/studioCatalog'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { fetchSessions } = useSessionStore()
  const location = useLocation()

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  return (
    <Box
      sx={{
        display: { xs: 'none', lg: 'grid' },
        gridTemplateRows: 'auto 1fr auto',
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        bgcolor: 'var(--studio-bg)',
        borderRight: '1px solid var(--studio-border)',
        overflow: 'hidden',
        transition: 'background-color var(--studio-motion), border-color var(--studio-motion)',
      }}
    >
      <Box
        sx={{
          height: 56,
          width: '100%',
          minWidth: 0,
          px: collapsed ? 1.4 : 2,
          display: 'flex',
          alignItems: 'center',
          gap: collapsed ? 0 : 1.3,
          transition: 'padding var(--studio-motion-slow), gap var(--studio-motion-slow)',
        }}
      >
        <Tooltip title={collapsed ? '展开侧边栏' : '收起侧边栏'} placement="right">
          <ButtonBase
            onClick={onToggle}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            sx={{
              width: 28,
              height: 28,
              flex: '0 0 28px',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 1.5,
              bgcolor: 'var(--studio-text)',
              color: 'var(--studio-inverse)',
              transition: 'background-color var(--studio-motion), color var(--studio-motion), transform var(--studio-motion-fast)',
              '&:hover': { transform: 'scale(1.04)' },
            }}
          >
            <HubIcon fontSize="small" />
          </ButtonBase>
        </Tooltip>
        <Box
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            opacity: collapsed ? 0 : 1,
            transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
            transition: 'opacity var(--studio-motion), transform var(--studio-motion), width var(--studio-motion-slow)',
            width: collapsed ? 0 : 160,
          }}
        >
          <Typography fontWeight={800}>AgentHub Studio</Typography>
        </Box>
      </Box>

      <Box
        sx={{
          minHeight: 0,
          width: '100%',
          minWidth: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          px: collapsed ? 1 : 1.5,
          py: 1,
          transition: 'padding var(--studio-motion-slow)',
          '& ul': {
            width: '100%',
          },
        }}
      >
        <NavGroup title="Primitives" items={primitiveItems} currentPath={location.pathname} collapsed={collapsed} />
        <NavGroup title="Runtime" items={runtimeItems} currentPath={location.pathname} collapsed={collapsed} />
        <NavGroup title="Evaluation" items={evaluationItems} currentPath={location.pathname} collapsed={collapsed} />
        <NavGroup title="Observability" items={observabilityItems} currentPath={location.pathname} collapsed={collapsed} />
      </Box>

      <Box sx={{ width: '100%', minWidth: 0, px: collapsed ? 1 : 1.5, pb: 1.4, transition: 'padding var(--studio-motion-slow)', '& ul': { width: '100%' } }}>
        <List dense disablePadding>
          {utilityItems.map((item) => (
            <NavItem key={item.path} item={item} active={isActive(location.pathname, item.path)} collapsed={collapsed} />
          ))}
        </List>
        <Box
          sx={{
            opacity: collapsed ? 0 : 1,
            transform: collapsed ? 'translateY(6px)' : 'translateY(0)',
            maxHeight: collapsed ? 0 : 88,
            overflow: 'hidden',
            pointerEvents: collapsed ? 'none' : 'auto',
            transition: 'opacity var(--studio-motion), transform var(--studio-motion), max-height var(--studio-motion-slow)',
          }}
        >
          <Divider sx={{ my: 1.2, borderColor: 'var(--studio-border)' }} />
          <ButtonBase
            sx={{
              width: '100%',
              justifyContent: 'space-between',
              px: 1.2,
              py: 0.9,
              borderRadius: 2,
              color: 'text.secondary',
            }}
          >
            <Typography variant="caption">Mastra</Typography>
            <Chip
              size="small"
              label="Mastra 功能迁移"
              sx={{
                height: 22,
                bgcolor: 'var(--studio-accent-soft)',
                color: 'var(--studio-accent)',
                border: '1px solid var(--studio-accent-soft)',
                fontWeight: 800,
              }}
            />
          </ButtonBase>
        </Box>
      </Box>
    </Box>
  )
}

function NavGroup({
  title,
  items,
  currentPath,
  collapsed,
}: {
  title: string
  items: StudioNavItem[]
  currentPath: string
  collapsed: boolean
}) {
  return (
    <Box sx={{ mb: 2.2, width: '100%', minWidth: 0 }}>
      <Box
        sx={{
          height: collapsed ? 0 : 20,
          opacity: collapsed ? 0 : 1,
          overflow: 'hidden',
          transform: collapsed ? 'translateX(-4px)' : 'translateX(0)',
          transition: 'height var(--studio-motion-slow), opacity var(--studio-motion), transform var(--studio-motion)',
        }}
      >
        <Typography
          variant="caption"
          sx={{ display: 'block', px: 1.3, mb: 0.65, color: 'text.secondary', fontWeight: 700 }}
        >
          {title}
        </Typography>
      </Box>
      <List dense disablePadding sx={{ width: '100%', minWidth: 0 }}>
        {items.map((item) => (
          <NavItem key={item.path} item={item} active={isActive(currentPath, item.path)} collapsed={collapsed} />
        ))}
      </List>
    </Box>
  )
}

function NavItem({ item, active, collapsed }: { item: StudioNavItem; active: boolean; collapsed: boolean }) {
  const content = (
    <ListItem
      disablePadding
      sx={{
        mb: 0.35,
        width: collapsed ? 40 : '100%',
        mx: collapsed ? 'auto' : 0,
        transition: 'width var(--studio-motion-slow)',
      }}
    >
      <ListItemButton
        component={NavLink}
        to={item.path}
        selected={active}
        sx={{
          minHeight: 38,
          width: collapsed ? 40 : '100%',
          height: collapsed ? 40 : 'auto',
          minWidth: collapsed ? 40 : 0,
          flex: collapsed ? '0 0 40px' : '1 1 auto',
          mx: collapsed ? 'auto' : 0,
          px: collapsed ? 0 : 2,
          overflow: 'hidden',
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius: 1.8,
          color: active ? 'text.primary' : 'text.secondary',
          transition: 'background-color var(--studio-motion), color var(--studio-motion), padding var(--studio-motion-slow), width var(--studio-motion-slow)',
          '&.Mui-selected': {
            bgcolor: 'var(--studio-surface-soft)',
            color: 'text.primary',
          },
          '&.Mui-selected:hover, &:hover': {
            bgcolor: active ? 'var(--studio-surface-soft)' : 'var(--studio-accent-soft)',
          },
        }}
      >
        <ListItemIcon
          sx={{
            width: collapsed ? 24 : 32,
            minWidth: collapsed ? 24 : 32,
            color: 'inherit',
            justifyContent: 'center',
            transition: 'min-width var(--studio-motion-slow), width var(--studio-motion-slow), color var(--studio-motion)',
            '& .MuiSvgIcon-root': {
              display: 'block',
              fontSize: 20,
            },
          }}
        >
          {item.icon}
        </ListItemIcon>
        <Box
          sx={{
            minWidth: 0,
            width: collapsed ? 0 : 142,
            opacity: collapsed ? 0 : 1,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
            transition: 'width var(--studio-motion-slow), opacity var(--studio-motion), transform var(--studio-motion)',
          }}
        >
          <ListItemText
            primary={item.label}
            primaryTypographyProps={{ fontWeight: active ? 800 : 650, fontSize: 15 }}
          />
        </Box>
      </ListItemButton>
    </ListItem>
  )
  return collapsed ? <Tooltip title={item.label} placement="right">{content}</Tooltip> : content
}

function isActive(currentPath: string, itemPath: string) {
  if (itemPath.startsWith('/agents/')) {
    return currentPath === '/agents' || currentPath.startsWith('/agents/')
  }
  if (itemPath === '/observability') {
    return currentPath === '/observability'
  }
  return currentPath === itemPath
}
