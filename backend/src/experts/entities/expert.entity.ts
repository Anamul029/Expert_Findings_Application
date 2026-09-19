import { Category } from 'src/categories/entities/category.entity';
import { Language } from 'src/languages/entities/language.entity';
import { Organization } from 'src/organizations/entities/organization.entity';
import { Price } from 'src/prices/entities/price.entity';
import { Qualification } from 'src/qualifications/entities/qualification.entity';
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
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

  @ManyToOne(() => User, (user) => user.experts, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  // M:N — Expert M—N Qualification via expert_qualifications
  @ManyToMany(() => Qualification, (qualification) => qualification.experts, {
    cascade: true,
  })
  @JoinTable({
    name: 'expert_qualifications',
    joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
    inverseJoinColumn: {
      name: 'qualification_id',
      referencedColumnName: 'id',
    },
  })
  qualifications!: Qualification[];

  // M:N — Expert M—N Language via expert_languages
  @ManyToMany(() => Language, (language) => language.experts, {
    cascade: true,
  })
  @JoinTable({
    name: 'expert_languages',
    joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'language_id', referencedColumnName: 'id' },
  })
  languages!: Language[];

  // M:N — Expert M—N Organization via expert_organizations
  @ManyToMany(() => Organization, (organization) => organization.experts, {
    cascade: true,
  })
  @JoinTable({
    name: 'expert_organizations',
    joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
    inverseJoinColumn: {
      name: 'organization_id',
      referencedColumnName: 'id',
    },
  })
  organizations!: Organization[];

  // M:N — Expert M—N Price via expert_prices
  @ManyToMany(() => Price, (price) => price.experts, { cascade: true })
  @JoinTable({
    name: 'expert_prices',
    joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'price_id', referencedColumnName: 'id' },
  })
  prices!: Price[];

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
