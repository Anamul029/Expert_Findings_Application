import { User } from 'src/user/entities/user.entity';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OtpType {
  VERIFICATION = 'verification',
  PASS_RESET = 'pass_reset',
}
@Entity()
export class Otp {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: OtpType })
  OtpType: OtpType;

  @Column({ type: 'varchar', length: 6 })
  oneTimeCode: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;
}
