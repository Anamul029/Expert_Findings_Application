import { Category } from 'src/categories/entities/category.entity';
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum VerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

export enum ProfileType {
  INDIVIDUAL = 'individual',
}

export enum AvailabilityStatus {
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
}

@Entity()
export class Expert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  verification_status!: VerificationStatus;

  @Column({ type: 'varchar', length: 100 })
  contact_preference!: string;

  @Column({ type: 'jsonb', nullable: true })
  attributes!: Record<string, unknown> | null;

  @Column({ type: 'text' })
  office_address!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updated_at!: Date;

  @Column({ type: 'int', default: 0 })
  years_experience!: number;

  @Column({
    type: 'enum',
    enum: ProfileType,
    default: ProfileType.INDIVIDUAL,
  })
  profile_type!: ProfileType;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  avg_rating!: number;

  @Column({ type: 'int', default: 0 })
  review_count!: number;

  @Column({
    type: 'enum',
    enum: AvailabilityStatus,
    default: AvailabilityStatus.AVAILABLE,
  })
  availibility_status!: AvailabilityStatus;
}
