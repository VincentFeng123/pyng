import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children: ReactNode;
};

export function Button({
  variant = 'secondary',
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = ['btn', `btn-${variant}`];
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}
