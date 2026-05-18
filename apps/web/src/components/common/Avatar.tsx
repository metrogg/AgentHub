import { Avatar as MuiAvatar } from '@mui/material'

interface Props {
  src?: string
  name?: string
}

export default function Avatar({ src, name }: Props) {
  return <MuiAvatar src={src}>{name?.charAt(0)}</MuiAvatar>
}
